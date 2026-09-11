import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# Existing isolation tests can leave synthetic app packages in sys.modules.
if sys.modules.get("app") is not None and not getattr(sys.modules["app"], "__file__", None):
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]

from app.routers import note as note_router
from app.services import note as note_service
from app.enmus.task_status_enums import TaskStatus
from app.models.notes_model import NoteResult
from app.models.audio_model import AudioDownloadResult
from app.models.transcriber_model import TranscriptResult


@pytest.fixture
def note():
    return NoteResult('# Lesson', TranscriptResult('en', 'text', []),
        AudioDownloadResult('audio.mp3', 'Title', 1, None, 'local', 'video', {}))


def atomic_save():
    function = getattr(note_router, 'atomic_save_note', None)
    assert function is not None, 'atomic_save_note is not implemented'
    return function


def test_atomic_save_flushes_and_syncs_before_replacing(tmp_path, monkeypatch, note):
    save = atomic_save()
    target = tmp_path / 'task.json'
    events = []
    real_sync, real_replace = os.fsync, os.replace
    def sync(fd):
        assert json.loads((tmp_path / 'task.json.tmp').read_text(encoding='utf-8'))['markdown'] == '# Lesson'
        assert not target.exists()
        events.append('sync')
        real_sync(fd)
    def replace(source, destination):
        assert events == ['sync']
        events.append('replace')
        real_replace(source, destination)
    monkeypatch.setattr(note_router.os, 'fsync', sync)
    monkeypatch.setattr(note_router.os, 'replace', replace)
    assert save('task', note, target) == target
    assert json.loads(target.read_text())['markdown'] == '# Lesson'
    assert events == ['sync', 'replace']
    assert not target.with_name('task.json.tmp').exists()


@pytest.mark.parametrize('failure', ['fsync', 'replace'])
def test_failed_atomic_save_preserves_previous_result(tmp_path, monkeypatch, note, failure):
    save = atomic_save()
    target = tmp_path / 'task.json'
    target.write_text('{"markdown":"old"}')
    def fail(*args):
        raise OSError('disk unavailable')
    monkeypatch.setattr(note_router.os, failure, fail)
    with pytest.raises(OSError, match='disk unavailable'):
        save('task', note, target)
    assert json.loads(target.read_text())['markdown'] == 'old'
    assert not target.with_name('task.json.tmp').exists()


@pytest.fixture
def runner(tmp_path, monkeypatch, note):
    monkeypatch.setattr(note_router, 'NOTE_OUTPUT_DIR', str(tmp_path))
    monkeypatch.setattr(note_service, 'NOTE_OUTPUT_DIR', tmp_path)
    monkeypatch.setattr(note_service.NoteGenerator, '_init_transcriber', lambda self: None)
    monkeypatch.setattr(note_service.NoteGenerator, 'generate', lambda *args, **kw: note)
    events = []
    def index(task_id):
        events.append('index')
        raise RuntimeError('optional index failure')
    monkeypatch.setitem(sys.modules, 'app.services.vector_store', SimpleNamespace(VectorStoreManager=lambda: SimpleNamespace(index_task=index)))
    return events


def test_success_is_emitted_after_saved_result_and_before_optional_index(runner, tmp_path):
    execute = getattr(note_router, 'execute_note_job', None)
    assert execute is not None, 'execute_note_job is not implemented'
    def callback(status, message=''):
        if status == TaskStatus.SUCCESS:
            assert json.loads((tmp_path / 'task.json').read_text())['markdown'] == '# Lesson'
        runner.append(status.value)
    result = execute(note_router.VideoRequest(video_url='local.mp4', platform='local', quality='medium',
        task_id='task', model_name='model', provider_id='provider'), callback)
    assert result == tmp_path / 'task.json'
    assert runner.index('SUCCESS') < runner.index('index')
    assert json.loads((tmp_path / 'task.status.json').read_text())['status'] == 'SUCCESS'


def test_save_failure_is_reported_without_success_or_index(runner, tmp_path, monkeypatch):
    execute = getattr(note_router, 'execute_note_job', None)
    assert execute is not None, 'execute_note_job is not implemented'
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(note_router, 'atomic_save_note', fail)
    with pytest.raises(OSError, match='disk full'):
        execute(note_router.VideoRequest(video_url='local.mp4', platform='local', quality='medium',
            task_id='task', model_name='model', provider_id='provider'), lambda status, message: runner.append(status.value))
    assert runner[-1] == 'FAILED'
    assert 'SUCCESS' not in runner and 'index' not in runner
    assert not (tmp_path / 'task.json').exists()


def test_legacy_runner_marks_success_only_after_save(runner, tmp_path, monkeypatch):
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(note_router, 'save_note_to_file', fail)
    with pytest.raises(OSError, match='disk full'):
        note_router.run_note_task('task', 'local.mp4', 'local', 'medium', model_name='model', provider_id='provider')
    status = tmp_path / 'task.status.json'
    assert status.exists() and json.loads(status.read_text())['status'] == 'FAILED'
    assert 'index' not in runner
