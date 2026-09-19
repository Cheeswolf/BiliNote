"""Persistent, single-slot note execution with OS-enforced scheduler ownership."""

import json
import logging
import os
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from app.db.models.note_batches import BatchStatus, NoteBatch
from app.db.models.note_jobs import JobStatus, NoteJob
from app.db.note_queue_dao import (
    TERMINAL_JOB_STATUSES,
    claim_next_job,
    recompute_batch_status,
    update_job_status,
)

from app.services.task_workspace import TaskWorkspace
from app.services.note_artifacts import generation_signature, load_note_result

logger = logging.getLogger(__name__)
_execution_lock = threading.Lock()
_lifecycle_lock = threading.Lock()
_active_worker: threading.Thread | None = None


class SchedulerOwnership:
    """Hold one byte in a persistent lock file; process death releases the lock.

    The file is never unlinked (unlinking permits two different locked inodes).
    SQLite uses the canonical database path, independent of working directory.
    Remote databases are rejected until they have a database advisory-lock
    implementation; a host-local lock cannot coordinate multiple hosts.
    """
    def __init__(self, session_factory):
        with session_factory() as session:
            url = session.get_bind().url
            if url.get_backend_name() != 'sqlite':
                raise RuntimeError('Note queue scheduler currently requires a local SQLite database')
            if (url.database in (None, '', ':memory:')
                    or url.database.lower().startswith('file:') or 'uri' in url.query):
                raise RuntimeError('Note queue scheduler requires an ordinary file-backed SQLite URL; '
                                   'SQLite URI and in-memory modes are unsupported')
            # SQLAlchemy resolves ordinary relative paths when the engine is
            # created, not here. Ask its actual connection for the main file:
            # resolving url.database against a later cwd can lock the wrong DB.
            databases = session.connection().exec_driver_sql('PRAGMA database_list').all()
            filename = next((row[2] for row in databases if row[1] == 'main'), '')
            if not filename:
                raise RuntimeError('Note queue scheduler requires a file-backed SQLite database')
            canonical = os.path.normcase(str(Path(filename).resolve()))
            self.path = Path(canonical + '.note-queue.lock')
        self.stream = None

    def acquire(self):
        if self.stream is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open('a+b')
        try:
            if stream.tell() == 0:
                stream.write(b'\0')
                stream.flush()
            stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            stream.close()
            raise RuntimeError('A note queue scheduler is already running for this database') from exc
        self.stream = stream

    def release(self):
        stream, self.stream = self.stream, None
        if stream is not None:
            # Closing the descriptor unlocks on Windows and POSIX, including
            # shutdown paths where an explicit unlock might itself fail.
            stream.close()


@dataclass(frozen=True)
class QueueJobContext:
    task_id: str
    attempt: int
    workspace: TaskWorkspace
    settings: dict[str, Any]


class NoteQueueService:
    """Run a synchronous runner; returning means its result is durably saved.

    Sessions are short-lived and never shared with the runner. Lifecycle guards
    enforce one daemon in this process; the OS lock also excludes other processes
    before they can perform startup recovery or claim any work.
    """

    def __init__(self, session_factory, runner: Callable[[QueueJobContext], Path | str | None]):
        self._session_factory = session_factory
        self._runner = runner
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._ownership = SchedulerOwnership(session_factory)

    @contextmanager
    def _owned(self):
        temporary = self._ownership.stream is None
        if temporary:
            self._ownership.acquire()
        try:
            yield
        finally:
            if temporary:
                self._ownership.release()

    def start(self) -> None:
        global _active_worker
        with _lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if _active_worker is not None and _active_worker.is_alive():
                raise RuntimeError("A note queue worker is already running")
            self._ownership.acquire()
            try:
                self.recover_interrupted_jobs()
                self._stop.clear()
                self._wake.clear()
                self._thread = threading.Thread(target=self._loop, name="note-queue", daemon=True)
                _active_worker = self._thread
                self._thread.start()
            except BaseException:
                self._ownership.release()
                raise

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
            if thread is None or not thread.is_alive():
                self._ownership.release()

    def wake(self) -> None:
        self._wake.set()

    def recover_interrupted_jobs(self) -> None:
        """Leave unfinished work for manual resume, preserving pending jobs."""
        if _active_worker is not None and _active_worker.is_alive():
            raise RuntimeError("A note queue worker is already running")
        with _execution_lock, self._owned(), self._session_factory() as session:
            unfinished = session.query(NoteJob).filter(
                NoteJob.status.notin_(TERMINAL_JOB_STATUSES)
            ).all()
            batch_ids = {job.batch_id for job in unfinished}
            now = datetime.utcnow()
            for job in unfinished:
                try:
                    workspace = TaskWorkspace.for_task(job.task_id)
                    settings = json.loads(job.settings_json if job.batch_id is None else job.batch.settings_json)
                    signature = generation_signature({**settings, 'task_id': job.task_id,
                        'video_url': job.normalized_url, 'platform': job.platform})
                    result = load_note_result(workspace, signature)
                    if result is not None:
                        # Repair the legacy projection before publishing SUCCESS.
                        from app.routers.note import save_note_to_file, NoteGenerator, TaskStatus
                        save_note_to_file(job.task_id, result)
                        NoteGenerator._update_status(job.task_id, TaskStatus.SUCCESS)
                        job.status = JobStatus.SUCCESS.value
                        job.result_path = str(workspace.result)
                        job.error_message = None
                        job.updated_at = now
                        continue
                except Exception:
                    logger.warning('Unable to repair saved result for %s', job.task_id, exc_info=True)
                if job.batch_id is None or job.status != JobStatus.PENDING.value:
                    job.status = JobStatus.INTERRUPTED.value
                    job.updated_at = now
            for batch in session.query(NoteBatch).filter(NoteBatch.id.in_(batch_ids)):
                batch.status = BatchStatus.RECOVERABLE.value
                batch.updated_at = now
            session.flush()
            for batch_id in batch_ids:
                recompute_batch_status(session, batch_id)
            session.commit()

    def run_once(self) -> bool:
        """Claim at most one job and persist success or failure before returning."""
        with _execution_lock, self._owned():
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
                        workspace=TaskWorkspace.for_task(task_id),
                        settings=json.loads(job.settings_json if job.batch_id is None else job.batch.settings_json),
                    )
                except Exception as exc:
                    update_job_status(session, task_id, attempt, JobStatus.FAILED, error_message=str(exc))
                    return True

            status, error, result_path = JobStatus.SUCCESS, None, None
            try:
                result_path = self._runner(context)
            except Exception as exc:
                status, error = JobStatus.FAILED, str(exc)
            with self._session_factory() as session:
                update_job_status(session, task_id, attempt, status, error_message=error,
                                  result_path=str(result_path) if result_path is not None else None)
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
        finally:
            with _lifecycle_lock:
                self._ownership.release()
