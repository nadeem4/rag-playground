"""Pandion's reports as plain JSON, for a run's result.

Each step carries `usage`: what its model call used (token counts and model
ids only), or null for a step that calls no model or came from the cache.
Each report carries `cost`: its `cost()` with the default price table."""

from __future__ import annotations

from typing import Any

from pandion import Answer, Retrieval, StageResult


def step(s: StageResult | None) -> dict[str, Any] | None:
    """One step: its stage and strategy, how it went, its result's id (fetch
    the result itself from GET /results/{id}), and its model usage or null."""
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
        "usage": s.usage,
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
        "cost": report.cost(),
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
        "cost": r.cost(),
    }


def answer(a: Answer) -> dict[str, Any]:
    """One question answered: the retrieval, the answer step, its text and its output."""
    return {
        **retrieval(a.retrieval),
        "ok": a.ok,
        "answer": step(a.answer),
        "text": a.text,
        "output": a.output.model_dump(mode="json") if a.output is not None else None,
        "cost": a.cost(),
    }


def evaluation(report: Any) -> dict[str, Any]:
    """An evaluation (what `pandion.evaluate` returns): its `to_dict()` and its cost."""
    return {**report.to_dict(), "cost": report.cost()}


def comparisons(results: Any) -> dict[str, Any]:
    """A comparison (what `pandion.compare` returns): its `to_dict()`, each
    variant's cost, and the cost of every variant together."""
    out = results.to_dict()
    for item, c in zip(out["comparisons"], results):
        item["cost"] = c.cost()
    return {**out, "cost": results.cost()}


def _add(values: list[Any]) -> Any:
    """The sum of the values that are not None, or None when every one is."""
    present = [v for v in values if v is not None]
    return sum(present) if present else None


def total(costs: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Several reports' `cost()` added up, for a comparison on one question.

    Unlike `Comparisons.cost()`, a cached step that several variants read is
    counted once per variant in `steps_cached`."""
    if not costs:
        return None
    return {
        "seconds": sum(c["seconds"] for c in costs),
        "input_tokens": _add([c["input_tokens"] for c in costs]),
        "output_tokens": _add([c["output_tokens"] for c in costs]),
        "dollars": _add([c["dollars"] for c in costs]),
        "unpriced_models": sorted({m for c in costs for m in c["unpriced_models"]}),
        "uncounted_models": sorted({m for c in costs for m in c["uncounted_models"]}),
        "steps_run": sum(c["steps_run"] for c in costs),
        "steps_cached": sum(c["steps_cached"] for c in costs),
        "prices_as_of": costs[0]["prices_as_of"],
    }
