"""Pandion's reports as plain JSON, for a run's result."""

from __future__ import annotations

from typing import Any

from pandion import StageResult


def step(s: StageResult | None) -> dict[str, Any] | None:
    """One step: its stage and strategy, how it went, and its result's id (fetch
    the result itself from GET /results/{id})."""
    if s is None:
        return None
    return {
        "stage": s.stage,
        "strategy": s.transform,
        "status": s.status,
        "result_id": s.artifact_id,
        "duration_ms": s.duration_ms,
        "note": s.note,
        "error": s.error,
    }


def index_report(report: Any) -> dict[str, Any]:
    """An index run (what `p.index.run` returns): each document's steps, and the index."""
    return {
        "ok": report.ok,
        "documents": {
            doc: {name: step(s) for name, s in document.stages.items()}
            for doc, document in report.documents.items()
        },
        "index": step(report.index),
    }
