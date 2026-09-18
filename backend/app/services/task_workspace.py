"""Paths owned by one note job; merely constructing a workspace does no I/O."""

from dataclasses import dataclass
from pathlib import Path
import re


@dataclass(frozen=True)
class TaskWorkspace:
    root: Path

    @classmethod
    def for_task(cls, task_id: str, root: Path | str = Path("data/tasks")) -> "TaskWorkspace":
        # A single portable spelling prevents Windows case/8.3/device/trailing
        # dot aliases from sharing data while the database treats IDs as distinct.
        reserved = {'con', 'prn', 'aux', 'nul', 'conin$', 'conout$'} | {
            f'{prefix}{number}' for prefix in ('com', 'lpt') for number in range(1, 10)
        }
        if (not isinstance(task_id, str)
                or not re.fullmatch(r'[a-z0-9_-][a-z0-9_.-]{0,127}', task_id)
                or task_id.endswith('.') or task_id.split('.')[0] in reserved):
            raise ValueError("task_id must be a canonical lowercase path component")
        if (Path(root) / task_id).resolve().parent != Path(root).resolve():
            raise ValueError("task_id workspace must stay inside its root")
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
