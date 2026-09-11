import enum
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import relationship

from app.db.engine import Base


class JobStatus(str, enum.Enum):
    PENDING = "PENDING"
    PARSING = "PARSING"
    DOWNLOADING = "DOWNLOADING"
    TRANSCRIBING = "TRANSCRIBING"
    SUMMARIZING = "SUMMARIZING"
    FORMATTING = "FORMATTING"
    SAVING = "SAVING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    INTERRUPTED = "INTERRUPTED"
    CANCELLED = "CANCELLED"


class NoteJob(Base):
    __tablename__ = "note_jobs"
    __table_args__ = (UniqueConstraint("batch_id", "position"),)

    task_id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    batch_id = Column(String, ForeignKey("note_batches.id"), nullable=True, index=True)
    position = Column(Integer, nullable=False)
    original_url = Column(Text, nullable=False)
    normalized_url = Column(Text, nullable=False)
    platform = Column(String, nullable=False)
    resource_key = Column(String, nullable=False)
    status = Column(String, nullable=False, default=JobStatus.PENDING.value)
    attempt = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)
    settings_json = Column(Text, nullable=True)
    result_path = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    batch = relationship("NoteBatch", back_populates="jobs")
