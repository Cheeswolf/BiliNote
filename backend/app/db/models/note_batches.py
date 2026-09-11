import enum
import uuid

from sqlalchemy import Column, DateTime, String, Text, func
from sqlalchemy.orm import relationship

from app.db.engine import Base


class BatchStatus(str, enum.Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    RECOVERABLE = "RECOVERABLE"
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    CANCELLED = "CANCELLED"


class NoteBatch(Base):
    __tablename__ = "note_batches"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    request_id = Column(String, unique=True, nullable=False, index=True)
    name = Column(String, nullable=False)
    source_label = Column(String, nullable=False)
    settings_json = Column(Text, nullable=False)
    status = Column(String, nullable=False, default=BatchStatus.PENDING.value)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    jobs = relationship(
        "NoteJob",
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="NoteJob.position",
    )
