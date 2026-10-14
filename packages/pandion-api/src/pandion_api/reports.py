"""Pandion's reports as plain JSON, for a run's result."""

from __future__ import annotations

from typing import Any

from pandion import Answer, Retrieval, StageResult


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


def retrieval(r: Retrieval) -> dict[str, Any]:
    """One question searched: the index it read, each retrieval step, and the hits."""
    return {
        "ok": r.ok,
        "index": step(r.index),
        "steps": {
            "rewrite": step(r.stages.get("rewrite")),
            "search": step(r.stages.get("search")),
            "rerank": [step(s) for s in r.stages.get("rerank", [])],
        },
        "hits": [hit.model_dump(mode="json") for hit in r.hits],
    }


def answer(a: Answer) -> dict[str, Any]:
    """One question answered: the retrieval, the answer step, its text and its output."""
    return {
        **retrieval(a.retrieval),
        "ok": a.ok,
        "answer": step(a.answer),
        "text": a.text,
        "output": a.output.model_dump(mode="json") if a.output is not None else None,
    }
