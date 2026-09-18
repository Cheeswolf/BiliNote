import json
from datetime import datetime

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import defer

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
                        title=item.get("title"),
                        cover_url=item.get("cover_url"),
                        duration=item.get("duration"),
                        status=JobStatus.PENDING.value,
                    )
                )
        return batch
    except IntegrityError:
        session.rollback()
        return session.query(NoteBatch).filter(NoteBatch.request_id == request_id).one()


class JobRetryConflict(ValueError):
    """Only failed or interrupted standalone jobs may be retried."""


def enqueue_single_job(session, task_id, settings, prepare=None, create_only=False):
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
        if job is not None and create_only:
            if job.batch_id is None and json.loads(job.settings_json) == snapshot:
                # Replaying a creation may acknowledge any state but never starts
                # another attempt or rewrites inputs/results of the existing job.
                return job
            raise JobRetryConflict("Task ID already belongs to another request")
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
    batch = session.query(NoteBatch).options(defer(NoteBatch.settings_json)).filter(NoteBatch.id == batch_id).one_or_none()
    jobs = (
        session.query(NoteJob)
        .options(defer(NoteJob.settings_json), defer(NoteJob.result_path))
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
                NoteJob.attempt == job.attempt,
                NoteJob.status == JobStatus.PENDING.value,
                or_(NoteJob.batch_id.is_(None), NoteJob.batch.has(
                    NoteBatch.status.in_(CLAIMABLE_BATCH_STATUSES))),
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
            recompute_batch_status(session, job.batch_id)
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
            NoteJob.status.notin_(TERMINAL_JOB_STATUSES | {JobStatus.INTERRUPTED.value}),
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
    if changed:
        batch_id = session.query(NoteJob.batch_id).filter(NoteJob.task_id == task_id).scalar()
        recompute_batch_status(session, batch_id)
    session.commit()
    return changed == 1


def get_batch_counts(session, batch_ids):
    counts = {batch_id: {status.value: 0 for status in JobStatus} for batch_id in batch_ids}
    if batch_ids:
        for batch_id, status, count in session.query(
            NoteJob.batch_id, NoteJob.status, func.count(NoteJob.task_id)
        ).filter(NoteJob.batch_id.in_(batch_ids)).group_by(NoteJob.batch_id, NoteJob.status):
            counts[batch_id][status] = count
    return counts


def list_batches(session, page, page_size):
    total = session.query(func.count(NoteBatch.id)).scalar()
    batches = (session.query(NoteBatch).options(defer(NoteBatch.settings_json))
               .order_by(NoteBatch.created_at.desc(), NoteBatch.id.desc())
               .offset((page - 1) * page_size).limit(page_size).all())
    return batches, total


def recompute_batch_status(session, batch_id):
    """Aggregate within the caller's write transaction, preserving manual gates."""
    if batch_id is None:
        return
    current = session.query(NoteBatch.status).filter(NoteBatch.id == batch_id).scalar()
    if current is None:
        return
    counts = get_batch_counts(session, [batch_id])[batch_id]
    present = {status for status, count in counts.items() if count}
    unfinished = present - TERMINAL_JOB_STATUSES
    active = unfinished - {JobStatus.PENDING.value, JobStatus.INTERRUPTED.value}
    if not unfinished:
        if present == {JobStatus.SUCCESS.value}:
            target = BatchStatus.COMPLETED.value
        elif present == {JobStatus.CANCELLED.value}:
            target = BatchStatus.CANCELLED.value
        else:
            target = BatchStatus.PARTIAL.value
    elif current in (BatchStatus.PAUSED.value, BatchStatus.RECOVERABLE.value):
        target = current
    elif active:
        target = BatchStatus.RUNNING.value
    elif counts[JobStatus.INTERRUPTED.value]:
        target = BatchStatus.RECOVERABLE.value
    else:
        target = BatchStatus.PENDING.value
    if target != current:
        session.query(NoteBatch).filter(NoteBatch.id == batch_id, NoteBatch.status == current).update(
            {'status': target, 'updated_at': datetime.utcnow()}, synchronize_session=False)


def manage_batch(session, batch_id, action):
    """Serialize controls using a batch write reservation and per-job CAS updates."""
    if action not in ('pause', 'resume', 'retry-failed', 'cancel-pending'):
        raise ValueError('Unknown batch action')
    try:
        while True:
            current = session.query(NoteBatch.status).filter(NoteBatch.id == batch_id).scalar()
            if current is None:
                session.rollback()
                return False
            target = current
            if action == 'pause' and current in CLAIMABLE_BATCH_STATUSES:
                target = BatchStatus.PAUSED.value
            elif action == 'resume' and current in (BatchStatus.PAUSED.value, BatchStatus.RECOVERABLE.value):
                target = BatchStatus.PENDING.value
            # Also reserves SQLite's write lock when the status remains unchanged.
            changed = session.query(NoteBatch).filter(
                NoteBatch.id == batch_id, NoteBatch.status == current,
            ).update({'status': target, 'updated_at': datetime.utcnow()}, synchronize_session=False)
            if changed:
                break
            session.rollback()

        eligible = []
        if action == 'resume' and current in (BatchStatus.PAUSED.value, BatchStatus.RECOVERABLE.value):
            eligible = [JobStatus.INTERRUPTED.value]
        elif action == 'retry-failed':
            eligible = [JobStatus.FAILED.value, JobStatus.INTERRUPTED.value]
        elif action == 'cancel-pending':
            eligible = [JobStatus.PENDING.value]
        jobs = session.query(NoteJob.task_id, NoteJob.status, NoteJob.attempt).filter(
            NoteJob.batch_id == batch_id, NoteJob.status.in_(eligible),
        ).all() if eligible else []
        changed_jobs = 0
        for task_id, status, attempt in jobs:
            values = {'status': JobStatus.CANCELLED.value if action == 'cancel-pending' else JobStatus.PENDING.value,
                      'updated_at': datetime.utcnow()}
            if action != 'cancel-pending':
                values.update(attempt=attempt + 1, error_message=None, result_path=None)
            changed_jobs += session.query(NoteJob).filter(
                NoteJob.task_id == task_id, NoteJob.batch_id == batch_id,
                NoteJob.status == status, NoteJob.attempt == attempt,
            ).update(values, synchronize_session=False)
        if action == 'retry-failed' and changed_jobs:
            session.query(NoteBatch).filter(NoteBatch.id == batch_id, NoteBatch.status == target).update(
                {'status': BatchStatus.PENDING.value}, synchronize_session=False)
        recompute_batch_status(session, batch_id)
        session.commit()
        session.expire_all()
        return True
    except Exception:
        session.rollback()
        raise
