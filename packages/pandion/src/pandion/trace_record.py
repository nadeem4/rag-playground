"""The trace record: what one chat turn did, kept so a person can read it later.

Provisional. A record holds the question, the standalone question it was searched
with, the answer, its grounding label, the sources, each stage's time and cost,
and later any flags, scores and feedback. It holds user text, so it follows the
conversation's retention and `delete_user`. It never holds a credential.
"""

from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, Field

#: The grounding labels of an answer, worst first. A turn's label is the worst one it has.
_WORST_FIRST = ("none", "weak", "similarity", "cited")


class Feedback(BaseModel):
    value: Literal["up", "down"]
    category: str = Field(default="", max_length=40)
    comment: str = Field(default="", max_length=500)
    created_at: str = ""


class TraceRecord(BaseModel):
    trace_id: str
    user_id: str
    conversation_id: str
    question: str
    standalone: str = ""
    answer: str = ""
    #: The worst grounding label in the answer, "not_found" when it only declined, "" when it has none.
    label: str = ""
    source_ids: list[str] = []
    #: One entry per stage, in order: `{"name", "ms", "dollars"}`.
    stages: list[dict[str, Any]] = []
    cost: float | None = None
    latency_ms: int = 0
    flags: list[str] = []
    scores: dict[str, float | str | bool] = {}
    feedback: list[Feedback] = []
    created_at: str = ""


def _label(answer: Any) -> str:
    payload = getattr(getattr(answer, "output", None), "payload", None) or {}
    stats = payload.get("stats") or {}
    for name in _WORST_FIRST:
        if stats.get(name):
            return name
    return "not_found" if stats.get("not_found") else ""


def _stages(answer: Any) -> list[dict[str, Any]]:
    from pandion.cost import cost

    rows = []
    for name, step in (getattr(answer, "stages", None) or {}).items():
        rows.append({"name": name, "ms": round(step.duration_ms), "dollars": cost([step])["dollars"]})
    return rows


def record_from_turn(
    result: Any, *, user_id: str, conversation_id: str, question: str, started: float, trace_id: str,
) -> TraceRecord:
    """Build the record of an answered turn. `started` is a `time.monotonic()` reading from before the turn."""
    answer = result.answer
    return TraceRecord(
        trace_id=trace_id, user_id=user_id, conversation_id=conversation_id, question=question,
        standalone=result.standalone, answer=result.text, label=_label(answer), source_ids=list(result.source_ids),
        stages=_stages(answer), cost=answer.cost().get("dollars"),
        latency_ms=round((time.monotonic() - started) * 1000),
    )
