import json
from datetime import datetime

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.db.models.note_batches import BatchStatus, NoteBatch
from app.db.models.note_jobs import JobStatus, NoteJob


SENSITIVE_SETTINGS_KEYS = {"api_key", "apiKey", "token"}
TERMINAL_JOB_STATUSES = {
    JobStatus.SUCCESS.value,
    JobStatus.FAILED.value,
    JobStatus.CANCELLED.value,
}
CLAIMABLE_BATCH_STATUSES = {
    BatchStatus.PENDING.value,
    BatchStatus.RUNNING.value,
}


def sanitize_settings(settings):
    if isinstance(settings, dict):
        return {
            key: sanitize_settings(value)
            for key, value in settings.items()
            if key not in SENSITIVE_SETTINGS_KEYS
        }
    if isinstance(settings, list):
        return [sanitize_settings(value) for value in settings]
    return settings


def create_batch(session, request_id, name, source_label, settings, items):
    try:
        with session.begin():
            batch = NoteBatch(
                request_id=request_id,
                name=name,
                source_label=source_label,
                settings_json=json.dumps(sanitize_settings(settings), ensure_ascii=False),
                status=BatchStatus.PENDING.value,
            )
            session.add(batch)
            session.flush()
            for position, item in enumerate(items):
                session.add(
                    NoteJob(
                        batch_id=batch.id,
                        position=position,
                        original_url=item["original_url"],
                        normalized_url=item["normalized_url"],
                        platform=item["platform"],
                        resource_key=item["resource_key"],
                        status=JobStatus.PENDING.value,
                    )
                )
        return batch
    except IntegrityError:
        session.rollback()
        return session.query(NoteBatch).filter(NoteBatch.request_id == request_id).one()


class JobRetryConflict(ValueError):
    """Only failed or interrupted standalone jobs may be retried."""


def enqueue_single_job(session, task_id, settings, prepare=None):
    """Commit only after task inputs exist; conditional retry reserves the attempt.

    prepare runs while the transaction owns its write lock so two requests cannot
    both overwrite a retry workspace. The worker never sees a half-ready job.
    """
    snapshot = sanitize_settings(settings)
    values = dict(
        original_url=snapshot["video_url"], normalized_url=snapshot["video_url"],
        platform=snapshot["platform"],
        resource_key=f"{snapshot['platform']}:{snapshot['video_url']}",
        settings_json=json.dumps(snapshot, ensure_ascii=False),
        status=JobStatus.PENDING.value, error_message=None, result_path=None,
        updated_at=datetime.utcnow(),
    )
    try:
        job = session.get(NoteJob, task_id)
        if job is None:
            job = NoteJob(task_id=task_id, batch_id=None, position=0, **values)
            session.add(job)
            session.flush()
        else:
            changed = session.query(NoteJob).filter(
                NoteJob.task_id == task_id,
                NoteJob.batch_id.is_(None),
                NoteJob.attempt == job.attempt,
                NoteJob.status.in_([JobStatus.FAILED.value, JobStatus.INTERRUPTED.value]),
            ).update({**values, "attempt": job.attempt + 1}, synchronize_session=False)
            if changed != 1:
                raise JobRetryConflict("Only failed or interrupted standalone tasks can be retried")
        if prepare is not None:
            prepare()
        session.commit()
        session.expire_all()
        return session.get(NoteJob, task_id)
    except IntegrityError as exc:
        session.rollback()
        raise JobRetryConflict("Task already exists") from exc
    except Exception:
        session.rollback()
        raise


def get_batch_detail(session, batch_id):
    batch = session.query(NoteBatch).filter(NoteBatch.id == batch_id).one()
    jobs = (
        session.query(NoteJob)
        .filter(NoteJob.batch_id == batch_id)
        .order_by(NoteJob.position)
        .all()
    )
    return batch, jobs


def claim_next_job(session):
    while True:
        active_job = (
            session.query(NoteJob.task_id)
            .filter(
                NoteJob.status.notin_([JobStatus.PENDING.value, JobStatus.INTERRUPTED.value]),
                NoteJob.status.notin_(TERMINAL_JOB_STATUSES),
            )
            .first()
        )
        if active_job is not None:
            session.rollback()
            return None

        job = (
            session.query(NoteJob)
            .outerjoin(NoteBatch)
            .filter(
                NoteJob.status == JobStatus.PENDING.value,
                or_(NoteJob.batch_id.is_(None), NoteBatch.status.in_(CLAIMABLE_BATCH_STATUSES)),
            )
            .order_by(
                func.coalesce(NoteBatch.created_at, NoteJob.created_at),
                func.coalesce(NoteBatch.id, NoteJob.task_id),
                NoteJob.position,
                NoteJob.task_id,
            )
            .first()
        )
        if job is None:
            session.rollback()
            return None

        changed = (
            session.query(NoteJob)
            .filter(
                NoteJob.task_id == job.task_id,
                NoteJob.status == JobStatus.PENDING.value,
            )
            .update(
                {
                    "status": JobStatus.PARSING.value,
                    "updated_at": datetime.utcnow(),
                },
                synchronize_session=False,
            )
        )
        if changed == 1:
            session.commit()
            session.expire_all()
            return session.get(NoteJob, job.task_id)
        session.rollback()


def update_job_status(
    session,
    task_id: str,
    attempt: int,
    status: JobStatus,
    *,
    error_message: str | None = None,
    result_path: str | None = None,
) -> bool:
    changed = (
        session.query(NoteJob)
        .filter(
            NoteJob.task_id == task_id,
            NoteJob.attempt == attempt,
        )
        .update(
            {
                "status": status.value,
                "error_message": error_message,
                **({"result_path": result_path} if result_path is not None else {}),
                "updated_at": datetime.utcnow(),
            }
        )
    )
    session.commit()
    return changed == 1
