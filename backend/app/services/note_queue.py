"""Persistent, single-slot note execution for one backend process."""

import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from app.db.models.note_batches import BatchStatus, NoteBatch
from app.db.models.note_jobs import JobStatus, NoteJob
from app.db.note_queue_dao import (
    CLAIMABLE_BATCH_STATUSES,
    TERMINAL_JOB_STATUSES,
    claim_next_job,
    update_job_status,
)

logger = logging.getLogger(__name__)
_execution_lock = threading.Lock()
_lifecycle_lock = threading.Lock()
_active_worker: threading.Thread | None = None


@dataclass(frozen=True)
class QueueJobContext:
    task_id: str
    attempt: int
    workspace: Path
    settings: dict[str, Any]


class NoteQueueService:
    """Run a synchronous runner; returning means its result is durably saved.

    Sessions are short-lived and never shared with the runner. Lifecycle guards
    enforce one daemon in this process; deployment must use one backend process.
    """

    def __init__(self, session_factory, runner: Callable[[QueueJobContext], None]):
        self._session_factory = session_factory
        self._runner = runner
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        global _active_worker
        with _lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if _active_worker is not None and _active_worker.is_alive():
                raise RuntimeError("A note queue worker is already running")
            self.recover_interrupted_jobs()
            self._stop.clear()
            self._wake.clear()
            self._thread = threading.Thread(target=self._loop, name="note-queue", daemon=True)
            _active_worker = self._thread
            self._thread.start()

    def stop(self) -> None:
        global _active_worker
        with _lifecycle_lock:
            self._stop.set()
            self._wake.set()
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join()
        with _lifecycle_lock:
            if _active_worker is thread and (thread is None or not thread.is_alive()):
                _active_worker = None

    def wake(self) -> None:
        self._wake.set()

    def recover_interrupted_jobs(self) -> None:
        """Leave unfinished work for manual resume, preserving pending jobs."""
        if _active_worker is not None and _active_worker.is_alive():
            raise RuntimeError("A note queue worker is already running")
        with _execution_lock, self._session_factory() as session:
            unfinished = session.query(NoteJob).filter(
                NoteJob.status.notin_(TERMINAL_JOB_STATUSES)
            ).all()
            batch_ids = {job.batch_id for job in unfinished}
            now = datetime.utcnow()
            for job in unfinished:
                if job.status != JobStatus.PENDING.value:
                    job.status = JobStatus.INTERRUPTED.value
                    job.updated_at = now
            for batch in session.query(NoteBatch).filter(NoteBatch.id.in_(batch_ids)):
                if batch.status in CLAIMABLE_BATCH_STATUSES or any(
                    job.batch_id == batch.id and job.status == JobStatus.INTERRUPTED.value
                    for job in unfinished
                ):
                    batch.status = BatchStatus.RECOVERABLE.value
                    batch.updated_at = now
            session.commit()

    def run_once(self) -> bool:
        """Claim at most one job and persist success or failure before returning."""
        with _execution_lock:
            if self._stop.is_set():
                return False
            with self._session_factory() as session:
                job = claim_next_job(session)
                if job is None:
                    return False
                task_id, attempt = job.task_id, job.attempt
                try:
                    context = QueueJobContext(
                        task_id=task_id,
                        attempt=attempt,
                        workspace=Path("data/tasks") / task_id,
                        settings=json.loads(job.batch.settings_json),
                    )
                except Exception as exc:
                    update_job_status(session, task_id, attempt, JobStatus.FAILED, error_message=str(exc))
                    return True

            status, error = JobStatus.SUCCESS, None
            try:
                self._runner(context)
            except Exception as exc:
                status, error = JobStatus.FAILED, str(exc)
            with self._session_factory() as session:
                update_job_status(session, task_id, attempt, status, error_message=error)
            return True

    def _loop(self) -> None:
        try:
            while not self._stop.is_set():
                self._wake.clear()
                if not self.run_once():
                    self._wake.wait(timeout=1.0)
        except Exception:
            # A database failure must not turn into continued untracked work.
            logger.exception("Note queue stopped; restart recovery is required")
            self._stop.set()
