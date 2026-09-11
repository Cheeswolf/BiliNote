import importlib
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Earlier module-isolation tests can leave an artificial app package behind.
if sys.modules.get("app") is not None and not getattr(sys.modules["app"], "__file__", None):
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]

from app.db.engine import Base
from app.db.models.note_batches import NoteBatch
from app.db.models.note_jobs import NoteJob
from app.db.note_queue_dao import create_batch


def load_queue_module():
    try:
        return importlib.import_module("app.services.note_queue")
    except ModuleNotFoundError as exc:
        if exc.name == "app.services.note_queue":
            pytest.fail("NoteQueueService has not been implemented")
        raise


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    engine = create_engine(f"sqlite:///{tmp_path / 'queue.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine)
    engine.dispose()


def add_batch(sessions, request_id="batch", statuses=("PENDING",), batch_status="PENDING"):
    with sessions() as session:
        batch = create_batch(session, request_id, "Course", "links", {"model_name": "demo"}, [
            {"original_url": f"https://example.com/{i}", "normalized_url": f"https://example.com/{i}",
             "platform": "example", "resource_key": f"example:{i}"}
            for i in range(len(statuses))
        ])
        batch_id = batch.id
        jobs = session.query(NoteJob).filter_by(batch_id=batch_id).order_by(NoteJob.position).all()
        ids = [job.task_id for job in jobs]
        for job, status in zip(jobs, statuses):
            job.status = status
        batch.status = batch_status
        session.commit()
        return batch_id, ids


def job_states(sessions, ids):
    with sessions() as session:
        return [(session.get(NoteJob, task_id).status, session.get(NoteJob, task_id).error_message) for task_id in ids]


def test_failure_is_persisted_and_next_job_runs(sessions):
    queue_module = load_queue_module()
    _, ids = add_batch(sessions, statuses=("PENDING",) * 3)
    seen = []

    def runner(context):
        seen.append(context)
        assert job_states(sessions, [context.task_id])[0][0] == "PARSING"
        if context.task_id == ids[1]:
            raise ValueError("download failed")

    service = queue_module.NoteQueueService(sessions, runner)
    assert [service.run_once() for _ in range(4)] == [True, True, True, False]
    assert [context.task_id for context in seen] == ids
    assert job_states(sessions, ids) == [("SUCCESS", None), ("FAILED", "download failed"), ("SUCCESS", None)]
    assert seen[0].attempt == 0
    assert seen[0].settings == {"model_name": "demo"}
    assert seen[0].workspace == Path("data/tasks") / ids[0]
    assert len({context.workspace for context in seen}) == 3


def test_concurrent_run_once_calls_share_one_slot(sessions):
    queue_module = load_queue_module()
    _, ids = add_batch(sessions, statuses=("PENDING",) * 3)
    state = {"active": 0, "peak": 0}
    seen = []
    lock = threading.Lock()

    def runner(context):
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
            seen.append(context.task_id)
        time.sleep(0.03)
        with lock:
            state["active"] -= 1

    services = [queue_module.NoteQueueService(sessions, runner) for _ in range(3)]
    with ThreadPoolExecutor(max_workers=3) as pool:
        assert list(pool.map(lambda service: service.run_once(), services)) == [True] * 3
    assert state["peak"] == 1
    assert seen == ids
    assert job_states(sessions, ids) == [("SUCCESS", None)] * 3


def test_recovery_interrupts_running_stages_and_requires_manual_resume(sessions):
    queue_module = load_queue_module()
    stages = ("PARSING", "DOWNLOADING", "TRANSCRIBING", "SUMMARIZING", "FORMATTING", "SAVING")
    batch_id, ids = add_batch(sessions, statuses=stages + ("PENDING", "SUCCESS", "FAILED", "CANCELLED"), batch_status="RUNNING")
    pending_id, pending_jobs = add_batch(sessions, "pending-only")
    paused_id, paused_jobs = add_batch(sessions, "paused", batch_status="PAUSED")
    complete_id, _ = add_batch(sessions, "complete", statuses=("SUCCESS",), batch_status="COMPLETED")
    seen = []
    service = queue_module.NoteQueueService(sessions, seen.append)

    service.recover_interrupted_jobs()
    service.recover_interrupted_jobs()

    assert [status for status, _ in job_states(sessions, ids)] == ["INTERRUPTED"] * 6 + ["PENDING", "SUCCESS", "FAILED", "CANCELLED"]
    assert job_states(sessions, pending_jobs) == [("PENDING", None)]
    assert job_states(sessions, paused_jobs) == [("PENDING", None)]
    with sessions() as session:
        assert session.get(NoteBatch, batch_id).status == "RECOVERABLE"
        assert session.get(NoteBatch, pending_id).status == "RECOVERABLE"
        assert session.get(NoteBatch, paused_id).status == "RECOVERABLE"
        assert session.get(NoteBatch, complete_id).status == "COMPLETED"
    assert service.run_once() is False
    assert seen == []


def test_start_recovers_pending_work_and_wake_runs_new_work(sessions):
    queue_module = load_queue_module()
    old_batch, old_ids = add_batch(sessions)
    ran = threading.Event()
    seen = []
    worker_threads = []

    def runner(context):
        seen.append(context.task_id)
        worker_threads.append(threading.current_thread())
        ran.set()

    service = queue_module.NoteQueueService(sessions, runner)
    try:
        service.start()
        service.start()
        with sessions() as session:
            assert session.get(NoteBatch, old_batch).status == "RECOVERABLE"
        _, new_ids = add_batch(sessions, "new")
        service.wake()
        assert ran.wait(3)
    finally:
        service.stop()
        service.stop()
    assert seen == new_ids
    assert worker_threads[0].daemon
    assert not worker_threads[0].is_alive()
    assert job_states(sessions, old_ids) == [("PENDING", None)]
    assert job_states(sessions, new_ids) == [("SUCCESS", None)]


def test_stop_finishes_current_job_without_claiming_next(sessions):
    queue_module = load_queue_module()
    entered, release = threading.Event(), threading.Event()
    seen = []

    def runner(context):
        seen.append(context.task_id)
        entered.set()
        assert release.wait(3)

    service = queue_module.NoteQueueService(sessions, runner)
    service.start()
    _, ids = add_batch(sessions, statuses=("PENDING",) * 2)
    service.wake()
    assert entered.wait(3)
    stopper = threading.Thread(target=service.stop)
    stopper.start()
    try:
        # stop must wait for the running job, not abandon it.
        stopper.join(0.05)
        assert stopper.is_alive()
    finally:
        release.set()
        stopper.join(3)
        service.stop()
    assert not stopper.is_alive()
    assert seen == ids[:1]
    assert job_states(sessions, ids) == [("SUCCESS", None), ("PENDING", None)]


def test_second_active_service_is_rejected(sessions):
    queue_module = load_queue_module()
    first = queue_module.NoteQueueService(sessions, lambda context: None)
    second = queue_module.NoteQueueService(sessions, lambda context: None)
    try:
        first.start()
        with pytest.raises(RuntimeError, match="already"):
            second.start()
    finally:
        first.stop()
        second.stop()


def test_terminal_write_does_not_overwrite_a_new_attempt(sessions):
    queue_module = load_queue_module()
    _, ids = add_batch(sessions)

    def runner(context):
        with sessions() as session:
            job = session.get(NoteJob, context.task_id)
            job.attempt = 1
            job.status = "PENDING"
            session.commit()

    service = queue_module.NoteQueueService(sessions, runner)
    assert service.run_once()
    assert job_states(sessions, ids) == [("PENDING", None)]


def test_context_preparation_failure_is_terminal(sessions):
    queue_module = load_queue_module()
    batch_id, ids = add_batch(sessions)
    with sessions() as session:
        session.get(NoteBatch, batch_id).settings_json = "invalid json"
        session.commit()
    seen = []
    service = queue_module.NoteQueueService(sessions, seen.append)
    assert service.run_once()
    assert job_states(sessions, ids)[0][0] == "FAILED"
    assert job_states(sessions, ids)[0][1]
    assert seen == []
