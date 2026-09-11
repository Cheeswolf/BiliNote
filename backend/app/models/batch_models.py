"""Strict batch API inputs and lightweight polling responses."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.db.models.note_batches import BatchStatus
from app.db.models.note_jobs import JobStatus

NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class BatchPreviewRequest(StrictRequest):
    lines: list[str]
    expand_multipart: bool = True


class BatchPreviewItem(StrictRequest):
    original_url: str
    normalized_url: str
    platform: str | None = None
    resource_key: str = ''
    title: str | None = None
    cover_url: str | None = None
    duration: float | None = None
    valid: bool = True
    error: str | None = None


class BatchSettings(StrictRequest):
    quality: Literal['fast', 'medium', 'slow']
    model_name: NonBlank
    provider_id: NonBlank
    style: str | None = None
    format: list[str] = Field(default_factory=list)
    screenshot: bool = False
    link: bool = False
    extras: str | None = None
    video_understanding: bool = False
    video_interval: int = Field(default=0, ge=0)
    grid_size: list[int] = Field(default_factory=list)


class BatchSubmitRequest(StrictRequest):
    request_id: NonBlank
    name: NonBlank
    source_label: NonBlank
    # The client sends only selected preview rows, in display order.
    items: list[BatchPreviewItem] = Field(min_length=1, max_length=100)
    settings: BatchSettings


class BatchSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    source_label: str
    status: BatchStatus
    created_at: datetime
    updated_at: datetime
    total: int
    counts: dict[str, int]


class BatchJobSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    task_id: str
    position: int
    original_url: str
    normalized_url: str
    platform: str
    resource_key: str
    title: str | None
    cover_url: str | None
    duration: float | None
    status: JobStatus
    attempt: int
    error_message: str | None
    created_at: datetime
    updated_at: datetime


class BatchDetail(BatchSummary):
    jobs: list[BatchJobSummary]
