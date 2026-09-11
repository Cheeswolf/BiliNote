"""Paths owned by one note job; merely constructing a workspace does no I/O."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TaskWorkspace:
    root: Path

    @classmethod
    def for_task(cls, task_id: str, root: Path | str = Path("data/tasks")) -> "TaskWorkspace":
        if not task_id or task_id in (".", "..") or any(c in task_id for c in '/\\:'):
            raise ValueError("task_id must be a non-empty path component")
        return cls(Path(root) / task_id)

    @property
    def task_id(self) -> str:
        """The task directory is the authoritative workspace owner."""
        return self.root.name

    @property
    def media(self) -> Path:
        return self.root / "media"

    @property
    def frames(self) -> Path:
        return self.root / "frames"

    @property
    def grids(self) -> Path:
        return self.root / "grids"

    @property
    def transcript(self) -> Path:
        return self.root / "transcript.json"

    @property
    def summary(self) -> Path:
        return self.root / "summary.md"

    @property
    def result(self) -> Path:
        return self.root / f"{self.task_id}.json"
