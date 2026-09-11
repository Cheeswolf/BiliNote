import sys

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
from app.db.models.note_jobs import JobStatus


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
    second = claim_next_job(db_session)
    third = claim_next_job(db_session)

    assert (first.batch_id, first.position, first.status) == (batch.id, 0, "PARSING")
    assert (second.batch_id, second.position, second.status) == (batch.id, 1, "PARSING")
    assert third is None


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
