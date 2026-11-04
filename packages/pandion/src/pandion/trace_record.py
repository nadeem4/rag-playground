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


#: A cited passage is cut to this many characters when a trace stores it.
SOURCE_TEXT_LIMIT = 2000


class TraceSource(BaseModel):
    id: str
    text: str


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
    #: The cited passages, each cut to 2,000 characters, for the relevance judge and `--promote`. Older traces have none.
    sources: list[TraceSource] = []
    #: One entry per stage, in order: `{"name", "ms", "dollars"}`.
    stages: list[dict[str, Any]] = []
    cost: float | None = None
    latency_ms: int = 0
    flags: list[str] = []
    scores: dict[str, float | str | bool] = {}
    feedback: list[Feedback] = []
    created_at: str = ""


def label_of(answer: Any) -> str:
    payload = getattr(getattr(answer, "output", None), "payload", None) or {}
    stats = payload.get("stats") or {}
    for name in _WORST_FIRST:
        if stats.get(name):
            return name
    return "not_found" if stats.get("not_found") else ""


def _stages(answer: Any) -> list[dict[str, Any]]:
    from pandion.cost import cost

    rows = []
    for name, value in (getattr(answer, "stages", None) or {}).items():
        # `rerank` holds a list of steps (one per reranker); every other stage is one step.
        steps = value if isinstance(value, list) else [value]
        for n, step in enumerate(steps, 1):
            label = f"{name}.{n}" if isinstance(value, list) else name
            rows.append({"name": label, "ms": round(step.duration_ms), "dollars": cost([step])["dollars"]})
    return rows


def _sources(result: Any) -> list[TraceSource]:
    """The cited hits' text by source id, in citation order. `answer.hits` is already role-filtered."""
    by_id: dict[str, str] = {}
    for hit in getattr(result.answer, "hits", None) or []:
        chunk = getattr(hit, "chunk", None)
        if getattr(chunk, "id", None) is not None:
            by_id.setdefault(chunk.id, chunk.text)
    return [TraceSource(id=i, text=by_id[i][:SOURCE_TEXT_LIMIT]) for i in result.source_ids if i in by_id]


def record_from_turn(
    result: Any, *, user_id: str, conversation_id: str, question: str, started: float, trace_id: str,
) -> TraceRecord:
    """Build the record of an answered turn. `started` is a `time.monotonic()` reading from before the turn."""
    answer = result.answer
    return TraceRecord(
        trace_id=trace_id, user_id=user_id, conversation_id=conversation_id, question=question,
        standalone=result.standalone, answer=result.text, label=label_of(answer), source_ids=list(result.source_ids),
        sources=_sources(result),
        stages=_stages(answer), cost=answer.cost().get("dollars"),
        latency_ms=round((time.monotonic() - started) * 1000), flags=list(getattr(result, "flags", [])),
    )
