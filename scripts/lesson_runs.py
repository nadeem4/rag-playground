"""Run a lesson's pipeline the way any Pandion user would, and hand back each
step's stored result by its step name. The recording scripts and the fixture
exporter share it, so none of them reaches into Pandion's insides.

Models load on the CPU, as the app loads them, unless the pipeline names a
`models` block of its own: the recordings must not move with the machine's GPU.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandion
from pandion import Pipeline, ResultStore

#: How the app loads local models (`api.deps.APP_MODELS`).
MODELS = {"device": "cpu"}


def _pipeline(pipeline: dict[str, Any], root: Path) -> Pipeline:
    return Pipeline.from_dict({"models": MODELS, **pipeline, "path": "."}, base=root)


def _fail(what: str, steps: dict[str, Any]) -> None:
    failed = {name: s.error for name, s in steps.items() if getattr(s, "error", None)}
    raise SystemExit(f"{what} failed: {failed}")


def run_pipeline(pipeline: dict[str, Any], pdf: Path, root: Path, question: str | None = None) -> dict[str, Any]:
    """Index `pdf` with `pipeline` under `root` (and ask `question`): each step's result by name."""
    p = _pipeline(pipeline, root)
    store = ResultStore(root)
    report = p.index.run([str(pdf)])
    [document] = report.documents.values()
    steps: dict[str, Any] = dict(document.stages)
    if not report.ok:
        _fail(f"indexing {pdf.name}", {**steps, "index": report.index})
    out: dict[str, Any] = {name: store.get(s.artifact_id) for name, s in steps.items() if s.artifact_id}
    descriptor = Path(store.get(report.index.artifact_id)) / "descriptor.json"
    out["index"] = json.loads(descriptor.read_text(encoding="utf-8"))
    durations = {name: s.duration_ms for name, s in steps.items()}
    durations["index"] = report.index.duration_ms
    if question is not None:
        a = p.ask(question)
        named = {"search": a.retrieval.stages["search"], "answer": a.answer}
        named.update({f"rerank.{n}": s for n, s in enumerate(a.retrieval.stages.get("rerank", []), start=1)})
        if not a.ok:
            _fail(f"asking {question!r}", named)
        out.update({name: store.get(s.artifact_id) for name, s in named.items() if s.artifact_id})
        durations.update({name: s.duration_ms for name, s in named.items()})
    out["duration_ms"] = durations
    return out


def evaluate_pipeline(pipeline: dict[str, Any], pdf: Path, root: Path, questions: list[dict]) -> dict[str, Any]:
    """`pandion.evaluate` of `pipeline` on `pdf` for `questions`, as plain JSON."""
    p = _pipeline(pipeline, root)
    return pandion.evaluate(p, questions, documents=[str(pdf)]).to_dict()
