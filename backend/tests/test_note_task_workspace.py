import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# Existing isolation tests can leave synthetic app packages in sys.modules.
if sys.modules.get("app") is not None and not getattr(sys.modules["app"], "__file__", None):
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]

from app.enmus.task_status_enums import TaskStatus
from app.models.audio_model import AudioDownloadResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.services import note as note_service


def workspace_for(task_id, root):
    try:
        module = importlib.import_module('app.services.task_workspace')
    except ModuleNotFoundError:
        pytest.fail('TaskWorkspace is not implemented')
    return module.TaskWorkspace.for_task(task_id, root=root)


@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    monkeypatch.setattr(note_service, 'NOTE_OUTPUT_DIR', tmp_path / 'legacy')
    monkeypatch.setattr(note_service, 'IMAGE_OUTPUT_DIR', str(tmp_path / 'static'))
    monkeypatch.setattr(note_service, 'IMAGE_BASE_URL', '/static/screenshots')
    init_calls, downloads, readers, sources = [], [], [], []
    transcript = TranscriptResult(language='en', full_text='lesson', segments=[TranscriptSegment(start=0, end=1, text='lesson')])
    transcriber = SimpleNamespace(transcript=lambda **kw: transcript)
    monkeypatch.setattr(note_service.NoteGenerator, '_init_transcriber', lambda self: init_calls.append('init') or transcriber)
    monkeypatch.setattr(note_service.NoteGenerator, '_save_metadata', lambda *a, **kw: None)

    class Downloader:
        def download_subtitles(self, url, output_dir=None):
            return transcript

        def download(self, **kw):
            downloads.append(kw)
            return AudioDownloadResult(file_path=str(Path(kw['output_dir']) / 'audio.mp3'), title='Lesson', duration=1,
                                       cover_url=None, platform='local', video_id='same-video', raw_info={})

        def download_video(self, url, output_dir=None):
            downloads.append({'video_output': output_dir})
            path = Path(output_dir) / 'video.mp4'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'video')
            return str(path)

    class Reader:
        def __init__(self, **kw):
            readers.append(kw)

        def run(self):
            return ['data:image/jpeg;base64,frame']

    downloader = Downloader()
    gpt = SimpleNamespace(summarize=lambda source: sources.append(source) or '# Lesson', checkpoint_dir=tmp_path / 'old-checkpoints')
    monkeypatch.setattr(note_service.NoteGenerator, '_get_downloader', lambda self, platform: downloader)
    monkeypatch.setattr(note_service.NoteGenerator, '_get_gpt', lambda *a: gpt)
    monkeypatch.setattr(note_service, 'VideoReader', Reader)
    return SimpleNamespace(init_calls=init_calls, downloads=downloads, readers=readers, sources=sources,
                           downloader=downloader, transcript=transcript, gpt=gpt)


def test_task_workspaces_do_not_share_paths_and_create_nothing_until_used(tmp_path):
    one, two = workspace_for('one', tmp_path), workspace_for('two', tmp_path)
    assert one.root == tmp_path / 'one'
    assert one.media.parent == one.root
    assert one.frames != two.frames
    assert one.grids != two.grids
    assert one.transcript.parent == one.root
    assert one.summary.parent == one.root
    assert one.result.parent == one.root
    assert not one.root.exists()


@pytest.mark.parametrize('task_id', ['../escape', 'a/b', 'a\\b', '', '..'])
def test_workspace_rejects_non_leaf_task_ids(tmp_path, task_id):
    with pytest.raises(ValueError):
        workspace_for(task_id, tmp_path)


def test_generator_initialization_does_not_load_whisper(pipeline):
    note_service.NoteGenerator()
    assert pipeline.init_calls == []


def test_workspace_pipeline_uses_real_task_id_and_isolated_media(pipeline, tmp_path):
    workspace = workspace_for('task_with_underscores', tmp_path)
    events = []
    result = note_service.NoteGenerator().generate('video', 'local', task_id='task_with_underscores',
        workspace=workspace, status_callback=lambda status, message: events.append(status), video_understanding=True, grid_size=[2, 2])
    assert result.markdown.endswith('# Lesson')
    assert pipeline.init_calls == []
    assert Path(pipeline.downloads[0]['video_output']) == workspace.media
    assert Path(pipeline.downloads[1]['output_dir']) == workspace.media
    assert Path(pipeline.readers[0]['frame_dir']) == workspace.frames
    assert Path(pipeline.readers[0]['grid_dir']) == workspace.grids
    assert pipeline.sources[0].checkpoint_key == 'task_with_underscores'
    assert pipeline.gpt.checkpoint_dir == workspace.root
    assert workspace.transcript.exists() and workspace.summary.exists()
    assert events == [TaskStatus.PARSING, TaskStatus.DOWNLOADING, TaskStatus.SUMMARIZING, TaskStatus.FORMATTING, TaskStatus.SAVING]
    statuses = list((tmp_path / 'legacy').glob('*.status.json'))
    assert [path.name for path in statuses] == ['task_with_underscores.status.json']
    assert json.loads(statuses[0].read_text())['status'] == 'SAVING'


def test_transcriber_is_loaded_only_for_fallback(pipeline, tmp_path):
    pipeline.downloader.download_subtitles = lambda url, output_dir=None: None
    events = []
    generator = note_service.NoteGenerator()
    assert pipeline.init_calls == []
    result = generator.generate('video', 'local', task_id='fallback_task', workspace=workspace_for('fallback_task', tmp_path),
                                status_callback=lambda status, message: events.append(status))
    assert result.transcript.full_text == 'lesson'
    assert pipeline.init_calls == ['init']
    assert events.count(TaskStatus.TRANSCRIBING) == 1
    assert not (tmp_path / 'legacy' / 'fallback.status.json').exists()


def test_generation_failure_reports_failure_and_raises_for_queue(pipeline, tmp_path):
    def fail(source):
        raise ValueError('model unavailable')
    pipeline.gpt.summarize = fail
    events = []
    with pytest.raises(ValueError, match='model unavailable'):
        note_service.NoteGenerator().generate('video', 'local', task_id='failed_task', workspace=workspace_for('failed_task', tmp_path),
            status_callback=lambda status, message: events.append((status, message)))
    assert events[-1] == (TaskStatus.FAILED, 'model unavailable')
    assert sum(status == TaskStatus.FAILED for status, _ in events) == 1
    assert all(status != TaskStatus.SUCCESS for status, _ in events)


def test_media_cache_retry_restores_video_and_grids(pipeline, tmp_path):
    workspace = workspace_for('retry', tmp_path)
    for _ in range(2):
        result = note_service.NoteGenerator().generate('video', 'local', task_id='retry', workspace=workspace,
                                                       video_understanding=True, grid_size=[2, 2])
        assert result is not None
    assert len(pipeline.readers) == 2
    assert all(source.video_img_urls for source in pipeline.sources)


def test_screenshots_are_task_owned_and_published_under_task_url(pipeline, tmp_path, monkeypatch):
    workspace = workspace_for('screen', tmp_path)
    def screenshot(video, output, timestamp, index):
        target = Path(output) / 'shot.jpg'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'image')
        return str(target)
    monkeypatch.setattr(note_service, 'generate_screenshot', screenshot)
    pipeline.gpt.summarize = lambda source: 'Screenshot-[00:01]'
    result = note_service.NoteGenerator().generate('video', 'local', task_id='screen', workspace=workspace,
                                                   screenshot=True, _format=['screenshot'])
    assert (workspace.frames / 'shot.jpg').read_bytes() == b'image'
    assert (tmp_path / 'static' / 'screen' / 'shot.jpg').read_bytes() == b'image'
    assert '![](/static/screenshots/screen/shot.jpg)' in result.markdown


def test_local_downloader_respects_output_directory(tmp_path, monkeypatch):
    from app.downloaders.local_downloader import LocalDownloader
    source = tmp_path / 'source.mp4'
    source.write_bytes(b'video')
    output = tmp_path / 'task' / 'media'
    locations = []
    def convert(self, input_path, output_path=None):
        locations.append(Path(output_path) if output_path else source.with_suffix('.mp3'))
        return str(locations[-1])
    def cover(self, input_path, output_dir=None):
        locations.append(Path(output_dir) if output_dir else source.parent)
        return str(locations[-1] / 'cover.jpg')
    monkeypatch.setattr(LocalDownloader, 'convert_to_mp3', convert)
    monkeypatch.setattr(LocalDownloader, 'extract_cover', cover)
    monkeypatch.setattr('app.downloaders.local_downloader.save_cover_to_static', lambda path: '/static/cover.jpg')
    result = LocalDownloader().download(str(source), output_dir=str(output))
    assert Path(result.file_path).parent == output
    assert locations[1] == output


def test_workspace_runner_uses_prefetched_transcript(pipeline, tmp_path, monkeypatch):
    from app.routers import note as note_router
    workspace = workspace_for('prefetched', tmp_path)
    monkeypatch.setattr(note_router, 'NOTE_OUTPUT_DIR', str(tmp_path / 'legacy'))
    monkeypatch.setitem(sys.modules, 'app.services.vector_store', SimpleNamespace(
        VectorStoreManager=lambda: SimpleNamespace(index_task=lambda task_id: None)))
    request = note_router.VideoRequest(video_url='video', platform='local', quality='medium',
        task_id='prefetched', model_name='model', provider_id='provider', prefetched_transcript={
            'language': 'en', 'full_text': 'from browser', 'segments': [{'start': 0, 'end': 1, 'text': 'from browser'}]})
    result_path = note_router.execute_note_job(request, workspace=workspace)
    assert result_path == workspace.result
    assert json.loads(result_path.read_text())['transcript']['full_text'] == 'from browser'
    assert json.loads(workspace.transcript.read_text())['full_text'] == 'from browser'
    assert pipeline.init_calls == []


def test_static_cover_projection_cannot_overwrite_another_task(tmp_path, monkeypatch):
    from app.utils.video_helper import save_cover_to_static
    monkeypatch.chdir(tmp_path)
    urls = []
    for task_id, content in [('one', b'one'), ('two', b'two')]:
        source = tmp_path / task_id / 'media' / 'cover.jpg'
        source.parent.mkdir(parents=True)
        source.write_bytes(content)
        urls.append(save_cover_to_static(str(source)))
    assert urls[0] != urls[1]
    from urllib.parse import urlparse
    assert [Path(urlparse(url).path.lstrip('/')).read_bytes() for url in urls] == [b'one', b'two']


def test_both_subtitle_attempts_use_task_media_directory(pipeline, tmp_path):
    workspace = workspace_for('subtitles', tmp_path)
    outputs = []
    def no_subtitles(url, output_dir=None):
        outputs.append(output_dir)
        return None
    pipeline.downloader.download_subtitles = no_subtitles
    result = note_service.NoteGenerator().generate('video', 'local', task_id='subtitles', workspace=workspace)
    assert result is not None
    assert outputs == [str(workspace.media), str(workspace.media)]


@pytest.mark.parametrize('entrypoint', ['generator', 'runner'])
def test_workspace_owner_mismatch_is_rejected_before_any_write(pipeline, tmp_path, monkeypatch, entrypoint):
    from app.routers import note as note_router
    workspace = workspace_for('task-b', tmp_path)
    monkeypatch.setattr(note_router, 'NOTE_OUTPUT_DIR', str(tmp_path / 'legacy'))
    events = []
    callback = lambda status, message: events.append(status)
    with pytest.raises(ValueError, match='workspace.*task'):
        if entrypoint == 'generator':
            note_service.NoteGenerator().generate('video', 'local', task_id='task-a', workspace=workspace,
                                                  status_callback=callback)
        else:
            request = note_router.VideoRequest(video_url='video', platform='local', quality='medium',
                task_id='task-a', model_name='model', provider_id='provider', prefetched_transcript={
                    'segments': [{'start': 0, 'end': 1, 'text': 'must not write'}]})
            note_router.execute_note_job(request, callback, workspace)
    assert not workspace.root.exists()
    assert not (tmp_path / 'legacy').exists()
    assert events == []
    assert pipeline.downloads == []


def test_second_subtitle_success_does_not_report_transcribing(pipeline, tmp_path):
    calls = []
    def subtitles(url, output_dir=None):
        calls.append(url)
        return pipeline.transcript if len(calls) == 2 else None
    pipeline.downloader.download_subtitles = subtitles
    events = []
    result = note_service.NoteGenerator().generate('video', 'local', task_id='second-subtitle',
        workspace=workspace_for('second-subtitle', tmp_path),
        status_callback=lambda status, message: events.append(status))
    assert result.transcript.full_text == 'lesson'
    assert pipeline.init_calls == []
    assert TaskStatus.TRANSCRIBING not in events
    assert events == [TaskStatus.PARSING, TaskStatus.DOWNLOADING, TaskStatus.SUMMARIZING,
                      TaskStatus.FORMATTING, TaskStatus.SAVING]
