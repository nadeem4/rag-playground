"""What one stage produced, in a form a person or an app can inspect."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class StageResult:
    """One stage's output, and how it was made.

    `status` is "executed", "cached" or "failed". `artifact_id` is the recipe
    hash the output is stored under; it is None when the stage ran on its own,
    without a store. `note` is the one sentence the stage left about this run,
    such as what a cleaner removed.
    """

    stage: str
    transform: str
    output: Any
    status: str = "executed"
    artifact_id: str | None = None
    duration_ms: float = 0.0
    note: str | None = None
    error: str | None = None
