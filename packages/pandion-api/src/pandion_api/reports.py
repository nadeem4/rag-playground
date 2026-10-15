"""Pandion's reports as plain JSON, for a run's result.

Each step carries `usage`: what its model call used (token counts and model
ids only), or null for a step that calls no model or came from the cache.
Each report carries `cost`: its `cost()` with the default price table. A
comparison also splits it: each variant's `varied_cost`, and the shared
steps once in `shared_cost`."""

from __future__ import annotations

from typing import Any

from pandion import Answer, Retrieval, StageResult, total_cost, varied_costs


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
    variant's cost, and the cost of every variant together; see `split`."""
    out = results.to_dict()
    return {**out, **split(list(results), out["comparisons"], results.varied_from)}


def split(variants: list[Any], items: list[dict[str, Any]], varied_from: str) -> dict[str, Any]:
    """Each variant's `cost` and `varied_cost` (the varied step and after, as
    if that variant ran on its own; see `pandion.varied_costs`) on its item,
    and the list's `varied_from`, `shared_cost` (the steps before the varied
    one, counted once) and `cost` (every variant together, each step once).
    `variants` are the reports, one per item."""
    for item, report, varied in zip(items, variants, varied_costs(variants, since=varied_from)):
        item["cost"] = report.cost()
        item["varied_cost"] = varied
    return {
        "comparisons": items,
        "varied_from": varied_from,
        "shared_cost": total_cost(variants, before=varied_from),
        "cost": total_cost(variants),
    }
