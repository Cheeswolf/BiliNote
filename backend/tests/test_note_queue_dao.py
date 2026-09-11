import sys
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def _restore_real_app_package():
    """Undo package stubs installed by earlier module-isolation tests."""
    app_package = sys.modules.get("app")
    if app_package is not None and not getattr(app_package, "__file__", None):
        for module_name in list(sys.modules):
            if module_name == "app" or module_name.startswith("app."):
                del sys.modules[module_name]


_restore_real_app_package()

from app.db.engine import Base
from app.db.note_queue_dao import (
    claim_next_job,
    create_batch,
    get_batch_detail,
    update_job_status,
)
from app.db.models.note_batches import BatchStatus, NoteBatch
from app.db.models.note_jobs import JobStatus, NoteJob


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


def test_create_batch_is_atomic_ordered_and_idempotent(db_session):
    items = [
        {
            "original_url": "https://www.bilibili.com/video/BV1xx?p=2",
            "normalized_url": "https://www.bilibili.com/video/BV1xx?p=2",
            "platform": "bilibili",
            "resource_key": "bilibili:BV1xx:p2",
        },
        {
            "original_url": "https://youtu.be/abcdefghijk",
            "normalized_url": "https://youtu.be/abcdefghijk",
            "platform": "youtube",
            "resource_key": "youtube:abcdefghijk",
        },
    ]
    first = create_batch(
        db_session,
        "request-1",
        "课程",
        "多行链接",
        {"model_name": "demo", "api_key": "secret"},
        items,
    )
    second = create_batch(
        db_session,
        "request-1",
        "课程",
        "多行链接",
        {"model_name": "demo"},
        items,
    )

    assert first.id == second.id
    _, jobs = get_batch_detail(db_session, first.id)
    assert [job.position for job in jobs] == [0, 1]
    assert "secret" not in first.settings_json


def test_create_batch_removes_nested_credentials_from_persisted_settings(db_session):
    batch = create_batch(
        db_session,
        "request-credentials",
        "课程",
        "多行链接",
        {
            "apiKey": "top-secret",
            "nested": {"token": "also-secret", "model_name": "demo"},
            "providers": [{"api_key": "third-secret"}],
        },
        [],
    )

    assert "secret" not in batch.settings_json
    assert '"model_name": "demo"' in batch.settings_json


def test_claim_next_job_claims_pending_jobs_in_position_order(db_session):
    batch = create_batch(
        db_session,
        "request-claim",
        "课程",
        "多行链接",
        {},
        [
            {
                "original_url": "https://example.com/first",
                "normalized_url": "https://example.com/first",
                "platform": "example",
                "resource_key": "example:first",
            },
            {
                "original_url": "https://example.com/second",
                "normalized_url": "https://example.com/second",
                "platform": "example",
                "resource_key": "example:second",
            },
        ],
    )

    first = claim_next_job(db_session)
    assert (first.batch_id, first.position, first.status) == (batch.id, 0, "PARSING")
    assert update_job_status(db_session, first.task_id, 0, JobStatus.SUCCESS)
    second = claim_next_job(db_session)
    assert (second.batch_id, second.position, second.status) == (batch.id, 1, "PARSING")
    assert update_job_status(db_session, second.task_id, 0, JobStatus.SUCCESS)
    third = claim_next_job(db_session)

    assert third is None


def test_claim_next_job_blocks_all_pending_jobs_while_a_job_is_active(db_session):
    create_batch(
        db_session,
        "request-active-first",
        "课程",
        "多行链接",
        {},
        [
            {
                "original_url": "https://example.com/first-0",
                "normalized_url": "https://example.com/first-0",
                "platform": "example",
                "resource_key": "example:first-0",
            },
            {
                "original_url": "https://example.com/first-1",
                "normalized_url": "https://example.com/first-1",
                "platform": "example",
                "resource_key": "example:first-1",
            },
        ],
    )
    create_batch(
        db_session,
        "request-active-second",
        "课程",
        "多行链接",
        {},
        [
            {
                "original_url": "https://example.com/second-0",
                "normalized_url": "https://example.com/second-0",
                "platform": "example",
                "resource_key": "example:second-0",
            }
        ],
    )

    claimed = claim_next_job(db_session)

    assert claimed.status == "PARSING"
    assert claim_next_job(db_session) is None


def test_claim_next_job_skips_jobs_in_a_paused_batch(db_session):
    batch = create_batch(
        db_session,
        "request-paused",
        "课程",
        "多行链接",
        {},
        [
            {
                "original_url": "https://example.com/paused",
                "normalized_url": "https://example.com/paused",
                "platform": "example",
                "resource_key": "example:paused",
            }
        ],
    )
    (
        db_session.query(NoteBatch)
        .filter(NoteBatch.id == batch.id)
        .update({"status": BatchStatus.PAUSED.value})
    )
    db_session.commit()

    assert claim_next_job(db_session) is None


def test_claim_next_job_breaks_equal_creation_times_by_batch_id(db_session):
    created_at = datetime(2026, 9, 11, 12, 0, 0)
    db_session.add_all(
        [
            NoteBatch(
                id="batch-z",
                request_id="request-tie-z",
                name="课程",
                source_label="多行链接",
                settings_json="{}",
                status=BatchStatus.PENDING.value,
                created_at=created_at,
            ),
            NoteBatch(
                id="batch-a",
                request_id="request-tie-a",
                name="课程",
                source_label="多行链接",
                settings_json="{}",
                status=BatchStatus.PENDING.value,
                created_at=created_at,
            ),
            NoteJob(
                task_id="job-z",
                batch_id="batch-z",
                position=0,
                original_url="https://example.com/z",
                normalized_url="https://example.com/z",
                platform="example",
                resource_key="example:z",
                status=JobStatus.PENDING.value,
                created_at=created_at,
            ),
            NoteJob(
                task_id="job-a",
                batch_id="batch-a",
                position=0,
                original_url="https://example.com/a",
                normalized_url="https://example.com/a",
                platform="example",
                resource_key="example:a",
                status=JobStatus.PENDING.value,
                created_at=created_at,
            ),
        ]
    )
    db_session.commit()

    claimed = claim_next_job(db_session)

    assert (claimed.batch_id, claimed.task_id) == ("batch-a", "job-a")


def test_update_job_status_requires_matching_attempt(db_session):
    batch = create_batch(
        db_session,
        "request-attempt",
        "课程",
        "多行链接",
        {},
        [
            {
                "original_url": "https://example.com/video",
                "normalized_url": "https://example.com/video",
                "platform": "example",
                "resource_key": "example:video",
            }
        ],
    )
    _, [job] = get_batch_detail(db_session, batch.id)

    assert update_job_status(db_session, job.task_id, 1, JobStatus.FAILED) is False
    assert update_job_status(
        db_session,
        job.task_id,
        0,
        JobStatus.FAILED,
        error_message="download failed",
    ) is True

    _, [updated_job] = get_batch_detail(db_session, batch.id)
    assert (updated_job.status, updated_job.error_message) == ("FAILED", "download failed")
