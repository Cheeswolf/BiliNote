import importlib
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

if sys.modules.get('app') is not None and not getattr(sys.modules['app'], '__file__', None):
    for name in list(sys.modules):
        if name == 'app' or name.startswith('app.'):
            del sys.modules[name]

from app.db.engine import Base, get_db
from app.db.models.note_jobs import NoteJob
from app.db.note_queue_dao import create_batch, update_job_status
from app.db.models.note_jobs import JobStatus
from app.routers import note
from app.services.note_queue import NoteQueueService
from app.services.transcriber_config_manager import TranscriberConfigManager


def payload(**changes):
    return dict(video_url='local.mp4', platform='local', quality='medium',
                model_name='demo', provider_id='provider', **changes)


@pytest.mark.parametrize('path', ['watch?v=dQw4w9WgXcQ', 'shorts/dQw4w9WgXcQ'])
def test_mobile_youtube_preview_url_is_accepted_by_execution(path):
    from app.services.batch_preview import normalize_video_url
    item = normalize_video_url('https://m.youtube.com/' + path)
    assert item.valid
    request = note.VideoRequest(video_url=item.normalized_url, platform='youtube',
                               quality='medium', model_name='demo', provider_id='provider')
    assert request.video_url.startswith('https://www.youtube.com/')


@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.services.provider import ProviderService
    monkeypatch.setattr(ProviderService, 'get_provider_by_id', lambda provider_id: {
        'id': provider_id, 'name': 'Fixture', 'type': 'custom',
        'api_key': 'offline-key', 'base_url': 'https://fixture.example/v1'})
    monkeypatch.chdir(tmp_path)
    engine = create_engine(f"sqlite:///{tmp_path / 'queue.db'}", connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(note, 'NOTE_OUTPUT_DIR', str(tmp_path / 'legacy'))
    monkeypatch.setattr(TranscriberConfigManager, 'is_model_ready', lambda self: {'ready': True})
    monkeypatch.setattr(note, 'run_note_task', lambda *args, **kwargs: None)
    scheduled = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, *args, **kwargs: scheduled.append(args))
    app = FastAPI()
    app.include_router(note.router, prefix='/api')
    def db():
        with sessions() as session:
            yield session
    app.dependency_overrides[get_db] = db
    wakes = []
    app.state.note_queue = SimpleNamespace(wake=lambda: wakes.append(True))
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, app=app, sessions=sessions, wakes=wakes,
                              scheduled=scheduled, root=tmp_path)
    engine.dispose()


def test_generate_note_enqueues_single_job_without_background_tasks(api):
    response = api.client.post('/api/generate_note', json=payload(style='course', screenshot=True))
    assert response.status_code == 200
    task_id = response.json()['data']['task_id']
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert job is not None, 'generate_note must persist a queue job'
        assert job.batch_id is None
        assert job.status == 'PENDING'
        settings = json.loads(job.settings_json)
        assert settings['style'] == 'course'
        assert settings['screenshot'] is True
        assert settings['provider_id'] == 'provider'
    assert api.wakes == [True]
    assert api.scheduled == []


def test_prefetched_transcript_is_ready_before_job_is_claimable(api, monkeypatch):
    monkeypatch.setattr(TranscriberConfigManager, 'is_model_ready', lambda self: pytest.fail('must skip readiness'))
    original_persist = note._persist_prefetched_transcript
    def persist(task_id, transcript, workspace=None, settings=None):
        with api.sessions() as session:
            assert session.get(NoteJob, task_id) is None
        original_persist(task_id, transcript, workspace, settings)
    monkeypatch.setattr(note, '_persist_prefetched_transcript', persist)
    def wake():
        with api.sessions() as session:
            job = session.query(NoteJob).one()
            transcript = api.root / 'data' / 'tasks' / job.task_id / 'transcript.json'
            assert json.loads(transcript.read_text())['segments'][0]['text'] == 'lesson'
            assert 'prefetched_transcript' not in json.loads(job.settings_json)
        api.wakes.append(True)
    api.app.state.note_queue.wake = wake
    response = api.client.post('/api/generate_note', json=payload(prefetched_transcript={
        'segments': [{'start': 0, 'end': 1, 'text': ' lesson '}], 'token': 'secret'}))
    assert response.status_code == 200
    assert api.wakes == [True]


def test_readiness_error_preserves_response_and_does_not_enqueue(api, monkeypatch):
    monkeypatch.setattr(TranscriberConfigManager, 'is_model_ready', lambda self: {
        'ready': False, 'reason': 'download model', 'transcriber_type': 'fast-whisper',
        'model_size': 'small', 'downloading': True})
    response = api.client.post('/api/generate_note', json=payload())
    assert response.json() == {'code': 300102, 'msg': 'download model', 'data': {
        'reason': 'transcriber_model_not_ready', 'transcriber_type': 'fast-whisper',
        'model_size': 'small', 'downloading': True}}
    with api.sessions() as session:
        assert session.query(NoteJob).count() == 0
    assert api.wakes == []


def test_invalid_prefetched_transcript_does_not_enqueue(api):
    response = api.client.post('/api/generate_note', json=payload(prefetched_transcript={'segments': []}))
    assert response.status_code == 400
    with api.sessions() as session:
        assert session.query(NoteJob).count() == 0
    assert api.wakes == []


@pytest.mark.parametrize('status', ['FAILED', 'INTERRUPTED'])
def test_retry_reuses_task_id_increments_attempt_and_rejects_stale_update(api, status):
    task_id = api.client.post('/api/generate_note', json=payload()).json()['data']['task_id']
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert job is not None
        job.status = status
        job.error_message = 'old error'
        session.commit()
    response = api.client.post('/api/generate_note', json=payload(task_id=task_id, style='retry'))
    assert response.json()['data']['task_id'] == task_id
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert (job.status, job.attempt, job.error_message) == ('PENDING', 1, None)
        assert json.loads(job.settings_json)['style'] == 'retry'
        assert not update_job_status(session, task_id, 0, JobStatus.SUCCESS)
    assert api.wakes == [True, True]


@pytest.mark.parametrize('status', ['PENDING', 'PARSING', 'SUCCESS', 'CANCELLED'])
def test_non_retryable_task_cannot_be_overwritten(api, status):
    task_id = api.client.post('/api/generate_note', json=payload()).json()['data']['task_id']
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert job is not None
        job.status = status
        session.commit()
    response = api.client.post('/api/generate_note', json=payload(task_id=task_id, prefetched_transcript={
        'segments': [{'text': 'must not write'}]}))
    assert response.status_code == 409
    assert not (api.root / 'data' / 'tasks' / task_id / 'transcript.json').exists()
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert (job.status, job.attempt) == (status, 0)
    assert api.wakes == [True]


def test_legacy_retry_task_id_creates_standalone_job(api):
    response = api.client.post('/api/generate_note', json=payload(task_id='legacy-task'))
    assert response.json()['data']['task_id'] == 'legacy-task'
    with api.sessions() as session:
        assert session.get(NoteJob, 'legacy-task') is not None


@pytest.mark.parametrize('batch_source', [False, True])
def test_regeneration_creates_idempotent_new_job_without_changing_source(api, batch_source):
    source_id = api.client.post('/api/generate_note', json=payload()).json()['data']['task_id']
    with api.sessions() as session:
        source = session.get(NoteJob, source_id)
        source.status = 'SUCCESS'
        session.commit()
    if batch_source:
        with api.sessions() as session:
            batch = create_batch(session, 'clone-source', 'source', 'links', {}, [{
                'original_url': 'local.mp4', 'normalized_url': 'local.mp4',
                'platform': 'local', 'resource_key': 'local:source'}])
            source_id = batch.jobs[0].task_id
            batch.jobs[0].status = 'SUCCESS'
            session.commit()
    submission = payload(task_id='new-version', create_only=True, parent_task_id=source_id)
    assert api.client.post('/api/generate_note', json=submission).status_code == 200
    assert api.client.post('/api/generate_note', json=submission).status_code == 200
    with api.sessions() as session:
        source = session.get(NoteJob, source_id)
        clone = session.get(NoteJob, 'new-version')
        assert source.status == 'SUCCESS'
        assert bool(source.batch_id) == batch_source
        assert clone.batch_id is None
        assert clone.attempt == 0
        assert json.loads(clone.settings_json)['parent_task_id'] == source_id
    changed = api.client.post('/api/generate_note', json={**submission, 'style': 'different'})
    assert changed.status_code == 409


@pytest.mark.parametrize('status', ['PENDING', 'TRANSCRIBING', 'FAILED', 'INTERRUPTED', 'CANCELLED'])
def test_task_status_prefers_database_over_stale_legacy_json(api, status):
    task_id = api.client.post('/api/generate_note', json=payload()).json()['data']['task_id']
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert job is not None
        job.status = status
        job.error_message = 'explanation'
        session.commit()
    legacy = api.root / 'legacy'
    legacy.mkdir(exist_ok=True)
    (legacy / f'{task_id}.status.json').write_text('{"status": "SUCCESS"}')
    (legacy / f'{task_id}.json').write_text('{"markdown": "stale"}')
    data = api.client.get(f'/api/task_status/{task_id}').json()['data']
    assert data == {'status': status, 'message': 'explanation', 'task_id': task_id}


def test_success_status_reads_workspace_result(api):
    task_id = api.client.post('/api/generate_note', json=payload()).json()['data']['task_id']
    target = api.root / 'data' / 'tasks' / task_id / f'{task_id}.json'
    target.parent.mkdir(parents=True)
    target.write_text('{"markdown": "saved note"}')
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert job is not None
        job.status = 'SUCCESS'
        job.result_path = str(target)
        session.commit()
    data = api.client.get(f'/api/task_status/{task_id}').json()['data']
    assert data['status'] == 'SUCCESS'
    assert data['result'] == {'markdown': 'saved note'}


@pytest.mark.parametrize('has_status', [False, True])
def test_legacy_history_stays_readable(api, has_status):
    legacy = api.root / 'legacy'
    legacy.mkdir()
    (legacy / 'old.json').write_text('{"markdown": "old note"}')
    if has_status:
        (legacy / 'old.status.json').write_text('{"status": "SUCCESS"}')
    data = api.client.get('/api/task_status/old').json()['data']
    assert data['status'] == 'SUCCESS'
    assert data['result'] == {'markdown': 'old note'}


def test_queue_runs_standalone_and_batch_in_one_slot_and_recovers_manually(api):
    old_id = api.client.post('/api/generate_note', json=payload()).json()['data']['task_id']
    seen = []
    queue = NoteQueueService(api.sessions, seen.append)
    queue.recover_interrupted_jobs()
    assert not queue.run_once(), 'old standalone work requires manual retry after restart'
    with api.sessions() as session:
        assert session.get(NoteJob, old_id).status == 'INTERRUPTED'
    new_id = api.client.post('/api/generate_note', json=payload()).json()['data']['task_id']
    with api.sessions() as session:
        batch = create_batch(session, 'batch', 'batch', 'links', {'model_name': 'batch-demo'}, [{
            'original_url': 'batch.mp4', 'normalized_url': 'batch.mp4', 'platform': 'local',
            'resource_key': 'local:batch'}])
        batch_job_id = batch.jobs[0].task_id
    assert queue.run_once()
    assert queue.run_once()
    assert not queue.run_once()
    assert {ctx.task_id for ctx in seen} == {new_id, batch_job_id}
    assert next(ctx for ctx in seen if ctx.task_id == new_id).settings['provider_id'] == 'provider'


def test_lifespan_owns_queue_runs_pipeline_and_stops_on_exception(api, monkeypatch):
    main = importlib.import_module('main')
    monkeypatch.setattr(main, 'init_db', lambda: None)
    monkeypatch.setattr(main, 'seed_default_providers', lambda: None)
    monkeypatch.setattr(main, 'register_handler', lambda: None)
    monkeypatch.setattr(main, 'SessionLocal', api.sessions, raising=False)
    from app.services.proxy_config_manager import ProxyConfigManager
    monkeypatch.setattr(ProxyConfigManager, 'apply_to_env', lambda self: None)
    completed = threading.Event()
    seen = []
    def execute(request, status_callback=None, workspace=None):
        seen.append((request, workspace))
        status_callback(note.TaskStatus.SUMMARIZING, '')
        with api.sessions() as session:
            assert session.get(NoteJob, request.task_id).status == 'SUMMARIZING'
        workspace.root.mkdir(parents=True)
        workspace.result.write_text('{"markdown": "from lifecycle"}')
        completed.set()
        return workspace.result
    monkeypatch.setattr(note, 'execute_note_job', execute)
    app = main.create_app(lifespan=main.lifespan)
    app.dependency_overrides.update(api.app.dependency_overrides)
    with pytest.raises(RuntimeError, match='body error'):
        with TestClient(app) as client:
            assert hasattr(app.state, 'note_queue'), 'lifespan must own the queue'
            response = client.post('/api/generate_note', json=payload())
            task_id = response.json()['data']['task_id']
            assert completed.wait(3)
            raise RuntimeError('body error')
    assert not app.state.note_queue._thread.is_alive()
    assert len(seen) == 1
    assert seen[0][0].task_id == task_id
    with api.sessions() as session:
        job = session.get(NoteJob, task_id)
        assert job.status == 'SUCCESS'
        assert Path(job.result_path).read_text() == '{"markdown": "from lifecycle"}'
