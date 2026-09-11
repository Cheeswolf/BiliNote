import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

if sys.modules.get('app') is not None and not getattr(sys.modules['app'], '__file__', None):
    for name in list(sys.modules):
        if name == 'app' or name.startswith('app.'):
            del sys.modules[name]

from app import create_app
from app.db.engine import Base, get_db
from app.db.models.note_batches import NoteBatch
from app.db.models.note_jobs import JobStatus, NoteJob
from app.db.note_queue_dao import create_batch, update_job_status
from app.services.note_queue import NoteQueueService


def item(index=0, **changes):
    url = f'https://youtu.be/{index:011d}'
    return dict(original_url=url, normalized_url=url, platform='youtube',
                resource_key=f'youtube:{index:011d}', **changes)


def payload(**changes):
    result = dict(request_id='request-1', name='Course', source_label='links',
                  items=[item()], settings=dict(quality='medium', model_name='demo', provider_id='provider'))
    result.update(changes)
    return result


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    engine = create_engine(f"sqlite:///{tmp_path / 'queue.db'}", connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    app = create_app(None)
    def db():
        with sessions() as session:
            yield session
    app.dependency_overrides[get_db] = db
    seen = []
    queue = NoteQueueService(sessions, lambda context: seen.append(context.task_id))
    app.state.note_queue = queue
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, sessions=sessions, queue=queue, seen=seen,
                              engine=engine, root=tmp_path)
    engine.dispose()


def seed(api, statuses, batch_status='PENDING', request_id='seed'):
    with api.sessions() as session:
        batch = create_batch(session, request_id, 'Seed', 'links', payload()['settings'],
                             [item(i) for i in range(len(statuses))])
        batch_id = batch.id
        jobs = session.query(NoteJob).filter_by(batch_id=batch_id).order_by(NoteJob.position).all()
        ids = [job.task_id for job in jobs]
        for job, status in zip(jobs, statuses):
            job.status = status
            if status in ('FAILED', 'INTERRUPTED'):
                job.error_message = 'old error'
                job.result_path = 'old/result.json'
        batch.status = batch_status
        session.commit()
    return batch_id, ids


def states(api, batch_id):
    with api.sessions() as session:
        return [(j.status, j.attempt, j.error_message) for j in
                session.query(NoteJob).filter_by(batch_id=batch_id).order_by(NoteJob.position)]


def test_preview_normalizes_deduplicates_invalid_rows_without_persistence(api):
    response = api.client.post('/api/batch/preview', json={
        'lines': ['https://youtu.be/00000000000?utm_source=share', 'https://youtu.be/00000000000',
                  'https://example.com/no-video'], 'expand_multipart': False})
    assert response.status_code == 200
    rows = response.json()['data']['items']
    assert len(rows) == 2
    assert (rows[0]['normalized_url'], rows[0]['valid']) == ('https://youtu.be/00000000000', True)
    assert rows[1]['valid'] is False and rows[1]['error']
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == session.query(NoteJob).count() == 0
    assert not api.queue._wake.is_set()


@pytest.mark.parametrize('count', [0, 101])
def test_submit_rejects_outside_selected_item_limit(api, count):
    response = api.client.post('/api/batch/submit', json=payload(items=[item(i) for i in range(count)]))
    assert response.status_code == 422
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == session.query(NoteJob).count() == 0


def test_submit_accepts_100_and_retries_return_same_ids_and_settings(api):
    body = payload(items=[item(i) for i in range(100)])
    first = api.client.post('/api/batch/submit', json=body)
    assert first.status_code == 200
    assert api.queue._wake.is_set()
    body['settings']['model_name'] = 'must not overwrite'
    second = api.client.post('/api/batch/submit', json=body)
    assert second.status_code == 200
    assert first.json()['data'] == second.json()['data']
    result = first.json()['data']
    assert len(result['task_ids']) == 100 and len(set(result['task_ids'])) == 100
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == 1
        batch = session.get(NoteBatch, result['batch_id'])
        assert json.loads(batch.settings_json)['model_name'] == 'demo'
        jobs = session.query(NoteJob).order_by(NoteJob.position).all()
        assert [job.task_id for job in jobs] == result['task_ids']
        assert [job.resource_key for job in jobs] == [f'youtube:{i:011d}' for i in range(100)]
    assert api.queue.run_once() is True
    assert api.seen == [result['task_ids'][0]]


def test_submit_revalidates_client_metadata_and_preserves_selected_part(api):
    selected = dict(original_url='https://www.bilibili.com/video/BV1xx',
                    normalized_url='https://www.bilibili.com/video/BV1xx?p=3&utm_source=share',
                    platform='youtube', resource_key='forged', valid=True, title='Part 3',
                    cover_url=None, duration=12.0, error=None)
    response = api.client.post('/api/batch/submit', json=payload(items=[selected]))
    assert response.status_code == 200
    with api.sessions() as session:
        job = session.query(NoteJob).one()
        assert (job.platform, job.resource_key, job.normalized_url) == (
            'bilibili', 'bilibili:BV1xx:p3', 'https://www.bilibili.com/video/BV1xx?p=3')


@pytest.mark.parametrize('items', [
    [item(), dict(item(1), normalized_url='file:///private', valid=True)],
    [item(), item()],
    [dict(item(), valid=False)],
])
def test_submit_rejects_invalid_or_duplicate_selected_rows_atomically(api, items):
    response = api.client.post('/api/batch/submit', json=payload(items=items))
    assert response.status_code == 400
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == session.query(NoteJob).count() == 0
    assert not api.queue._wake.is_set()


@pytest.mark.parametrize('changes', [
    {'api_key': 'secret'}, {'token': 'secret'}, {'apiKey': 'secret'},
    {'nested': {'token': 'secret'}}, {'format': [{'api_key': 'secret'}]},
    {'screenshot': 'yes'}, {'quality': 'invalid'}, {'model_name': ''}, {'provider_id': '  '},
])
def test_submit_rejects_unsafe_or_invalid_settings(api, changes):
    body = payload()
    body['settings'].update(changes)
    response = api.client.post('/api/batch/submit', json=body)
    assert response.status_code == 422
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == 0


def test_submit_transaction_rolls_back_when_job_insert_fails(api):
    def fail_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO note_jobs'):
            raise RuntimeError('storage unavailable')
    event.listen(api.engine, 'before_cursor_execute', fail_insert)
    try:
        with pytest.raises(RuntimeError, match='storage unavailable'):
            api.client.post('/api/batch/submit', json=payload())
    finally:
        event.remove(api.engine, 'before_cursor_execute', fail_insert)
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == session.query(NoteJob).count() == 0
    assert not api.queue._wake.is_set()


def test_concurrent_submit_is_idempotent(api):
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: api.client.post('/api/batch/submit', json=payload()), range(2)))
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json()['data'] == responses[1].json()['data']
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == session.query(NoteJob).count() == 1


def test_list_pagination_and_detail_are_ordered_and_lightweight(api):
    first, ids = seed(api, ['SUCCESS', 'FAILED', 'INTERRUPTED', 'PENDING'], 'RECOVERABLE')
    second, _ = seed(api, ['PENDING'], request_id='second')
    with api.sessions() as session:
        session.get(NoteBatch, first).created_at = datetime(2026, 1, 1)
        session.get(NoteBatch, second).created_at = datetime(2026, 1, 2)
        session.get(NoteJob, ids[0]).result_path = str(api.root / 'private-result.json')
        session.commit()
    (api.root / 'private-result.json').write_text('{"markdown": "do not read or return"}')
    response = api.client.get('/api/batch?page=1&page_size=1')
    assert response.status_code == 200
    listing = response.json()['data']
    assert listing['total'] == 2 and len(listing['items']) == 1
    assert listing['items'][0]['id'] == second
    assert 'jobs' not in listing['items'][0]
    assert api.client.get('/api/batch?page=2&page_size=1').json()['data']['items'][0]['id'] == first
    detail = api.client.get(f'/api/batch/{first}').json()['data']
    assert [j['task_id'] for j in detail['jobs']] == ids
    assert [j['position'] for j in detail['jobs']] == [0, 1, 2, 3]
    assert detail['total'] == 4
    assert detail['counts']['SUCCESS'] == detail['counts']['FAILED'] == detail['counts']['INTERRUPTED'] == 1
    assert 'markdown' not in json.dumps(detail) and 'result_path' not in json.dumps(detail)
    assert 'settings_json' not in json.dumps(detail)


def test_pause_during_execution_leaves_current_job_running_and_blocks_next(api):
    batch_id, ids = seed(api, ['PENDING', 'PENDING'])
    started, finish = threading.Event(), threading.Event()
    def runner(context):
        started.set()
        assert finish.wait(5)
    api.queue._runner = runner
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(api.queue.run_once)
        assert started.wait(5)
        try:
            response = api.client.post(f'/api/batch/{batch_id}/pause')
            assert response.status_code == 200
            assert response.json()['data']['status'] == 'PAUSED'
            assert [s[0] for s in states(api, batch_id)] == ['PARSING', 'PENDING']
        finally:
            finish.set()
        assert running.result(timeout=5)
    assert states(api, batch_id)[0][0] == 'SUCCESS'
    assert api.queue.run_once() is False
    assert api.client.get(f'/api/batch/{batch_id}').json()['data']['status'] == 'PAUSED'


@pytest.mark.parametrize('batch_status', ['PAUSED', 'RECOVERABLE'])
def test_manual_resume_requeues_only_interrupted_and_blocks_stale_callbacks(api, batch_status):
    batch_id, ids = seed(api, ['INTERRUPTED', 'PENDING', 'SUCCESS', 'FAILED'], batch_status)
    assert api.queue.run_once() is False
    response = api.client.post(f'/api/batch/{batch_id}/resume')
    assert response.status_code == 200
    assert response.json()['data']['status'] == 'PENDING'
    assert states(api, batch_id) == [('PENDING', 1, None), ('PENDING', 0, None),
                                    ('SUCCESS', 0, None), ('FAILED', 0, 'old error')]
    with api.sessions() as session:
        assert not update_job_status(session, ids[0], 0, JobStatus.SUCCESS)
    assert api.queue._wake.is_set()
    assert api.queue.run_once() is True
    assert api.seen == [ids[0]]


def test_retry_failed_only_requeues_failed_interrupted_once_and_keeps_success(api):
    batch_id, ids = seed(api, ['SUCCESS', 'FAILED', 'INTERRUPTED', 'PENDING', 'CANCELLED'], 'RECOVERABLE')
    for _ in range(2):
        response = api.client.post(f'/api/batch/{batch_id}/retry-failed')
        assert response.status_code == 200
    assert states(api, batch_id) == [('SUCCESS', 0, None), ('PENDING', 1, None),
                                    ('PENDING', 1, None), ('PENDING', 0, None), ('CANCELLED', 0, None)]
    with api.sessions() as session:
        assert session.get(NoteJob, ids[1]).result_path is None
        assert not update_job_status(session, ids[1], 0, JobStatus.FAILED)
    assert api.queue._wake.is_set()
    assert api.queue.run_once() is True
    assert api.seen == [ids[1]]


def test_cancel_pending_does_not_touch_running_or_terminal_jobs(api):
    batch_id, _ = seed(api, ['PENDING', 'SUMMARIZING', 'FAILED', 'SUCCESS', 'INTERRUPTED'], 'RUNNING')
    response = api.client.post(f'/api/batch/{batch_id}/cancel-pending')
    assert response.status_code == 200
    assert [s[:2] for s in states(api, batch_id)] == [
        ('CANCELLED', 0), ('SUMMARIZING', 0), ('FAILED', 0), ('SUCCESS', 0), ('INTERRUPTED', 0)]
    assert response.json()['data']['status'] == 'RUNNING'


@pytest.mark.parametrize('initial, expected', [(['PENDING'], 'CANCELLED'),
    (['SUCCESS', 'PENDING'], 'PARTIAL'), (['FAILED', 'PENDING'], 'PARTIAL')])
def test_cancel_pending_recomputes_terminal_batch_status(api, initial, expected):
    batch_id, _ = seed(api, initial, 'PAUSED')
    response = api.client.post(f'/api/batch/{batch_id}/cancel-pending')
    assert response.status_code == 200
    assert response.json()['data']['status'] == expected


def test_worker_updates_batch_running_and_terminal_status(api):
    batch_id, _ = seed(api, ['PENDING', 'PENDING'])
    def runner(context):
        response = api.client.get(f'/api/batch/{batch_id}')
        assert response.status_code == 200
        assert response.json()['data']['status'] == 'RUNNING'
    api.queue._runner = runner
    assert api.queue.run_once() and api.queue.run_once()
    response = api.client.get(f'/api/batch/{batch_id}')
    assert response.status_code == 200
    assert response.json()['data']['status'] == 'COMPLETED'
    with api.sessions() as session:
        assert session.get(NoteBatch, batch_id).status == 'COMPLETED'


@pytest.mark.parametrize('method, suffix', [('get', ''), ('post', '/pause'), ('post', '/resume'),
    ('post', '/retry-failed'), ('post', '/cancel-pending')])
def test_missing_batch_returns_404(api, method, suffix):
    assert getattr(api.client, method)('/api/batch/missing' + suffix).status_code == 404


def test_pause_wins_against_job_selected_before_pause(api):
    batch_id, _ = seed(api, ['PENDING'])
    intercepted = []
    def pause_before_claim(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('UPDATE note_jobs') and not intercepted:
            intercepted.append(True)
            assert api.client.post(f'/api/batch/{batch_id}/pause').status_code == 200
    event.listen(api.engine, 'before_cursor_execute', pause_before_claim)
    try:
        assert api.queue.run_once() is False
    finally:
        event.remove(api.engine, 'before_cursor_execute', pause_before_claim)
    assert intercepted == [True]
    assert states(api, batch_id) == [('PENDING', 0, None)]


def test_concurrent_retry_advances_each_attempt_only_once(api):
    batch_id, _ = seed(api, ['SUCCESS', 'FAILED', 'INTERRUPTED'], 'RECOVERABLE')
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(
            lambda _: api.client.post(f'/api/batch/{batch_id}/retry-failed'), range(2)))
    assert [r.status_code for r in responses] == [200, 200]
    assert states(api, batch_id) == [('SUCCESS', 0, None), ('PENDING', 1, None), ('PENDING', 1, None)]


def test_cancelled_job_rejects_late_same_attempt_callback(api):
    batch_id, ids = seed(api, ['PENDING'])
    assert api.client.post(f'/api/batch/{batch_id}/cancel-pending').status_code == 200
    with api.sessions() as session:
        assert not update_job_status(session, ids[0], 0, JobStatus.SUCCESS)
        assert session.get(NoteJob, ids[0]).status == 'CANCELLED'
        assert session.get(NoteBatch, batch_id).status == 'CANCELLED'


def test_worker_failure_ends_batch_as_partial(api):
    batch_id, ids = seed(api, ['PENDING', 'PENDING'])
    def runner(context):
        if context.task_id == ids[0]:
            raise RuntimeError('cannot download')
    api.queue._runner = runner
    assert api.queue.run_once() and api.queue.run_once()
    detail = api.client.get(f'/api/batch/{batch_id}').json()['data']
    assert detail['status'] == 'PARTIAL'
    assert (detail['counts']['FAILED'], detail['counts']['SUCCESS']) == (1, 1)


def test_pause_and_resume_do_not_reopen_completed_batch(api):
    batch_id, _ = seed(api, ['SUCCESS'], 'COMPLETED')
    for action in ('pause', 'resume', 'retry-failed', 'cancel-pending'):
        response = api.client.post(f'/api/batch/{batch_id}/{action}')
        assert response.status_code == 200
        assert response.json()['data']['status'] == 'COMPLETED'
    assert states(api, batch_id) == [('SUCCESS', 0, None)]


@pytest.mark.parametrize('endpoint, body', [
    ('preview', {'lines': 'not a list'}), ('preview', {'lines': [], 'expand_multipart': 'yes'}),
    ('preview', {'lines': [], 'api_key': 'secret'}),
    ('submit', dict(payload(), unexpected='secret')),
])
def test_requests_reject_unknown_fields_and_type_coercion(api, endpoint, body):
    assert api.client.post(f'/api/batch/{endpoint}', json=body).status_code == 422


def test_submit_persists_preview_metadata_in_display_order(api):
    body = payload(items=[
        dict(item(2), title='Second lesson', cover_url='https://images.example/2.jpg', duration=12.5),
        dict(item(1), title='First lesson', cover_url=None, duration=0.0),
        item(0),
    ])
    response = api.client.post('/api/batch/submit', json=body)
    assert response.status_code == 200
    batch_id = response.json()['data']['batch_id']
    with api.sessions() as session:
        jobs = session.query(NoteJob).filter_by(batch_id=batch_id).order_by(NoteJob.position).all()
        assert [(job.title, job.cover_url, job.duration) for job in jobs] == [
            ('Second lesson', 'https://images.example/2.jpg', 12.5), ('First lesson', None, 0.0),
            (None, None, None)]
    detail = api.client.get(f'/api/batch/{batch_id}').json()['data']
    assert [(job['title'], job['cover_url'], job['duration']) for job in detail['jobs']] == [
        ('Second lesson', 'https://images.example/2.jpg', 12.5), ('First lesson', None, 0.0),
        (None, None, None)]
    assert [job['resource_key'] for job in detail['jobs']] == [
        'youtube:00000000002', 'youtube:00000000001', 'youtube:00000000000']


def test_submit_malformed_url_is_validation_error_without_persistence(api):
    response = api.client.post('/api/batch/submit', json=payload(items=[
        dict(item(), normalized_url='http://[')]))
    assert response.status_code == 400
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == 0


def test_preview_malformed_url_does_not_drop_valid_neighbor(api):
    response = api.client.post('/api/batch/preview', json={
        'lines': ['http://[', 'https://youtu.be/00000000000'], 'expand_multipart': False})
    assert response.status_code == 200
    rows = response.json()['data']['items']
    assert len(rows) == 2
    assert rows[0]['valid'] is False and rows[0]['error']
    assert rows[1]['valid'] is True


@pytest.mark.parametrize('literal', ['1e400', 'Infinity', '-1', 'NaN'])
def test_submit_rejects_invalid_duration_before_persistence(api, literal):
    body = json.dumps(payload(items=[dict(item(), duration='DURATION')])).replace('"DURATION"', literal)
    response = api.client.post('/api/batch/submit', content=body,
                               headers={'content-type': 'application/json'})
    assert response.status_code == 422
    errors = response.json()['detail']
    assert errors[0]['loc'] == ['body', 'items', 0, 'duration']
    assert set(errors[0]) == {'loc', 'type', 'msg'}
    json.dumps(response.json(), allow_nan=False)
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == session.query(NoteJob).count() == 0
    assert not api.queue._wake.is_set()


@pytest.mark.parametrize('duration', [float('inf'), float('nan'), -1.0])
def test_preview_item_model_rejects_invalid_duration(duration):
    from pydantic import ValidationError
    from app.models.batch_models import BatchPreviewItem
    with pytest.raises(ValidationError):
        BatchPreviewItem(**item(), duration=duration)


@pytest.mark.parametrize('grid_size', [[2], [0, 2], [-1, 2], [1, 2, 3]])
def test_submit_rejects_invalid_grid_size_before_persistence(api, grid_size):
    body = payload()
    body['settings']['grid_size'] = grid_size
    response = api.client.post('/api/batch/submit', json=body)
    assert response.status_code == 422
    with api.sessions() as session:
        assert session.query(NoteBatch).count() == session.query(NoteJob).count() == 0
    assert not api.queue._wake.is_set()


@pytest.mark.parametrize('duration, grid_size', [(None, []), (0.0, [1, 2]), (12.5, [2, 2])])
def test_submit_valid_duration_and_grid_size_keep_detail_serializable(api, duration, grid_size):
    body = payload(items=[dict(item(), duration=duration)])
    body['settings']['grid_size'] = grid_size
    response = api.client.post('/api/batch/submit', json=body)
    assert response.status_code == 200
    detail = api.client.get('/api/batch/' + response.json()['data']['batch_id'])
    assert detail.status_code == 200
    assert detail.json()['data']['jobs'][0]['duration'] == duration
    json.dumps(detail.json(), allow_nan=False)
    with api.sessions() as session:
        batch = session.query(NoteBatch).one()
        assert json.loads(batch.settings_json)['grid_size'] == grid_size
