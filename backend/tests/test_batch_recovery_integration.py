"""Crash/restart integration using real routes, SQLite, and queue workers.

Only the costly media/model runner is replaced. Killing a test-owned subprocess
models desktop interruption; graceful stop() intentionally finishes its job.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import create_app
from app.db.engine import Base, get_db
from app.db.models.note_jobs import JobStatus, NoteJob
from app.db.note_queue_dao import update_job_status
from app.services.note_queue import NoteQueueService


def _sessions(root):
    engine = create_engine(f"sqlite:///{root / 'queue.db'}",
                           connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


def _runner(sessions, root, *, interrupt_third=False):
    def run(context):
        with sessions() as session:
            position = session.get(NoteJob, context.task_id).position
            update_job_status(session, context.task_id, context.attempt, JobStatus.SUMMARIZING)
        with (root / 'attempts.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps([context.task_id, context.attempt]) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        if position == 1:
            raise RuntimeError('controlled inaccessible video')
        if position == 2 and interrupt_third:
            (root / 'third-active').touch()
            threading.Event().wait()  # Parent terminates only this test process.
        context.workspace.root.mkdir(parents=True, exist_ok=True)
        temporary = context.workspace.result.with_suffix('.tmp')
        with temporary.open('w', encoding='utf-8') as stream:
            json.dump({'task_id': context.task_id, 'markdown': f'# Note {position + 1}'}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, context.workspace.result)
        return context.workspace.result
    return run


def _client(sessions, queue):
    app = create_app(None)

    def db():
        with sessions() as session:
            yield session

    app.dependency_overrides[get_db] = db
    app.state.note_queue = queue
    return TestClient(app)


def _wait_for(predicate, message):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(message)


def _detail(client, batch_id):
    response = client.get(f'/api/batch/{batch_id}')
    assert response.status_code == 200
    return response.json()['data']


def test_restart_requires_manual_resume_and_preserves_success(tmp_path, monkeypatch):
    # Catches missing startup recovery, automatic restart, failed-item retry on
    # resume, success reruns, lost result paths, and incorrect batch aggregation.
    source_root = Path(__file__).resolve().parents[1]
    monkeypatch.chdir(tmp_path)
    engine, sessions = _sessions(tmp_path)
    environment = dict(os.environ, PYTHONPATH=str(source_root))
    worker_log = (tmp_path / 'worker.log').open('w', encoding='utf-8')
    worker = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), '--worker', str(tmp_path)],
        cwd=tmp_path, env=environment, stdout=worker_log, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    try:
        _wait_for(lambda: (tmp_path / 'ready').exists(), 'test worker did not start')
        with _client(sessions, NoteQueueService(sessions, _runner(sessions, tmp_path))) as client:
            response = client.post('/api/batch/submit', json={
                'request_id': 'recovery-integration', 'name': 'Recovery integration',
                'source_label': 'controlled fixtures',
                'settings': {'quality': 'medium', 'model_name': 'fixture', 'provider_id': 'fixture'},
                'items': [dict(original_url=f'https://youtu.be/{i:011d}',
                               normalized_url=f'https://youtu.be/{i:011d}',
                               platform='youtube', resource_key=f'youtube:{i:011d}')
                          for i in range(3)],
            })
            assert response.status_code == 200
            batch_id = response.json()['data']['batch_id']
            ids = response.json()['data']['task_ids']
            _wait_for(lambda: (tmp_path / 'third-active').exists(),
                      'worker did not continue past failed second job')
            before = _detail(client, batch_id)
            assert before['status'] == 'RUNNING'
            assert [job['status'] for job in before['jobs']] == ['SUCCESS', 'FAILED', 'SUMMARIZING']
            assert [job['attempt'] for job in before['jobs']] == [0, 0, 0]
            first_result = tmp_path / 'data' / 'tasks' / ids[0] / f'{ids[0]}.json'
            saved_bytes = first_result.read_bytes()
        worker.terminate()
        worker.wait(timeout=10)
        assert worker.returncode is not None
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait(timeout=10)
        worker_log.close()
        engine.dispose()

    # Reopen the persisted database and recreate both application and service.
    engine, sessions = _sessions(tmp_path)
    restarted = NoteQueueService(sessions, _runner(sessions, tmp_path))
    try:
        restarted.start()
        with _client(sessions, restarted) as client:
            recovered = _detail(client, batch_id)
            assert recovered['status'] == 'RECOVERABLE'
            assert [job['status'] for job in recovered['jobs']] == ['SUCCESS', 'FAILED', 'INTERRUPTED']
            assert [job['attempt'] for job in recovered['jobs']] == [0, 0, 0]
            assert restarted.run_once() is False
            assert [json.loads(line) for line in (tmp_path / 'attempts.jsonl').read_text().splitlines()] == [
                [ids[0], 0], [ids[1], 0], [ids[2], 0],
            ]
            response = client.post(f'/api/batch/{batch_id}/resume')
            assert response.status_code == 200
            _wait_for(lambda: _detail(client, batch_id)['status'] == 'PARTIAL',
                      'manual resume did not finish remaining work')
            final = _detail(client, batch_id)
            assert [job['task_id'] for job in final['jobs']] == ids
            assert [job['status'] for job in final['jobs']] == ['SUCCESS', 'FAILED', 'SUCCESS']
            assert [job['attempt'] for job in final['jobs']] == [0, 0, 1]
            assert final['counts']['SUCCESS'] == 2
            assert final['counts']['FAILED'] == 1
            assert sum(final['counts'].values()) == final['total'] == 3
            assert final['jobs'][1]['error_message'] == 'controlled inaccessible video'
            assert restarted.run_once() is False
        restarted.stop()
        assert [json.loads(line) for line in (tmp_path / 'attempts.jsonl').read_text().splitlines()] == [
            [ids[0], 0], [ids[1], 0], [ids[2], 0], [ids[2], 1],
        ]
        assert first_result.read_bytes() == saved_bytes
        with sessions() as session:
            first, failed, third = [session.get(NoteJob, task_id) for task_id in ids]
            assert Path(first.result_path).resolve() == first_result
            assert failed.result_path is None
            third_result = Path(third.result_path)
            assert third_result.parent != first_result.parent
            assert json.loads(third_result.read_text())['task_id'] == ids[2]
    finally:
        restarted.stop()
        engine.dispose()


if __name__ == '__main__':
    root = Path(sys.argv[2])
    worker_engine, worker_sessions = _sessions(root)
    queue = NoteQueueService(worker_sessions, _runner(worker_sessions, root, interrupt_third=True))
    queue.start()
    (root / 'ready').touch()
    threading.Event().wait()
