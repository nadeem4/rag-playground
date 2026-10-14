"""Evaluate a pipeline on a question set, and compare settings: the public names.

A question set is the JSON format the bundled samples use (a list of
questions, or an object with a "questions" list), or a CSV file with the same
columns, or the same list in code. Each question has `question` and at least
one gold passage (`gold_answer` or `gold_answers`): the sentence in the
document that answers it. `id`, `answer`, `tags` and `document` are optional.
`trace` follows one question's answer down a finished run and says the first step
that lost it. `evaluate` asks every question in a set and runs `trace` for every miss.
`compare` runs a pipeline once per variant of one stage and evaluates each.
See docs/pandion.md, "Evaluate a pipeline" and "Compare settings".
"""

from __future__ import annotations

import copy
import statistics
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from pandion.config import ConfigError, _block, from_dict, to_dict
from pandion.events import event
from pandion.payloads import ChunkSet, Query
from pandion.pipeline import IndexReport, Pipeline, Retrieval
from pandion.plugins import discover
from pandion.plugins.chunk import DocView
from pandion.ports import Stage
from pandion.questions import (
    GOLD_SEPARATOR,
    QuestionSetError,
    check_questions,
    load_questions,
    parse_question_set,
)
from pandion.registry import registry
from pandion.results import StageResult
from pandion.trace import StepInput, _holds, trace

__all__ = [
    "COMPARE_STAGES",
    "Comparison",
    "Comparisons",
    "EvaluationReport",
    "GOLD_SEPARATOR",
    "QuestionResult",
    "QuestionSetError",
    "StepInput",
    "check_questions",
    "compare",
    "evaluate",
    "load_questions",
    "parse_question_set",
    "trace",
]


@dataclass
class QuestionResult:
    """One question's verdict.

    `found` and `rank` are the eval step's: the answer is in the top `top_k`
    pieces, and the rank of the first piece that holds it. For a miss,
    `lost_at` is the first step that lost the answer (parse, clean, chunk,
    search, rerank or top_k) and `trace` says why, step by step, with the
    document it was traced in. `score` is the eval step's whole payload.
    `error` says which retrieval step failed, when one did; the question is
    then left out of the rates. `retrieval` is what `p.retrieve` returned.
    A question with no `id` in the set is named by its place, "question 3".
    """

    id: str
    question: str
    golds: list[str]
    tags: list[str]
    found: bool
    rank: int | None
    lost_at: str | None
    trace: dict[str, Any] | None
    score: dict[str, Any]
    error: str | None = None
    retrieval: Retrieval | None = field(default=None, repr=False)

    @property
    def result_id(self) -> str | None:
        """The artifact id of the retrieval's final result (the last
        reranker's, or the search's), or None when retrieval failed."""
        if self.retrieval is None or not self.retrieval.ok:
            return None
        return self.retrieval._steps()[-1].artifact_id

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON, without the retrieval, but with its final result's id
        (`result_id`), so the hit rows can be fetched by id."""
        return {
            "id": self.id,
            "question": self.question,
            "golds": list(self.golds),
            "tags": list(self.tags),
            "found": self.found,
            "rank": self.rank,
            "lost_at": self.lost_at,
            "trace": self.trace,
            "score": dict(self.score),
            "error": self.error,
            "result_id": self.result_id,
        }


@dataclass
class EvaluationReport:
    """Every question's verdict, at `top_k` pieces checked, and the totals."""

    top_k: int
    questions: list[QuestionResult]
    #: A cancel stopped the run before every question was asked.
    cancelled: bool = False

    @property
    def total(self) -> int:
        return len(self.questions)

    @property
    def found(self) -> int:
        return sum(q.found for q in self.questions)

    def totals(self) -> dict[str, Any]:
        """The numbers for the whole set; see `_totals`."""
        return _totals(self.questions)

    def by_tag(self) -> dict[str, dict[str, Any]]:
        """The same numbers for the questions carrying each tag."""
        tags = sorted({tag for q in self.questions for tag in q.tags})
        return {tag: _totals([q for q in self.questions if tag in q.tags]) for tag in tags}

    def __str__(self) -> str:
        """One plain line per question, then the totals."""
        lines = [_line(q) for q in self.questions]
        t = self.totals()
        total = f"Found {t['found']} of {t['scored']}"
        if t["scored"]:
            total += f" ({t['hit_rate']:.0%}). Mean reciprocal rank {t['mrr']:.2f}."
        else:
            total += "."
        failed = t["total"] - t["scored"]
        if failed:
            total += f" {failed} question{'' if failed == 1 else 's'} could not be scored."
        out = [*lines, total]
        if self.cancelled:
            out.append("Stopped before every question was asked.")
        return "\n".join(out)

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON: the totals, the totals by tag, and every question."""
        return {
            "top_k": self.top_k,
            "cancelled": self.cancelled,
            **self.totals(),
            "by_tag": self.by_tag(),
            "questions": [q.to_dict() for q in self.questions],
        }


def _line(q: QuestionResult) -> str:
    """One question's verdict in plain words."""
    if q.error is not None:
        return f"{q.id} error: {q.error}"
    if q.found:
        return f"{q.id} found at rank {q.rank}"
    finding = (q.trace or {}).get("finding") or f"Lost at {q.lost_at}."
    return f"{q.id} missed. {finding}"


def _totals(questions: list[QuestionResult]) -> dict[str, Any]:
    """Hit rate, mean reciprocal rank, recall and ranks, over the scored questions.

    The same arithmetic as the Evaluate page's metrics: a question whose
    retrieval failed is not scored; a miss counts zero towards the mean
    reciprocal rank; recall counts gold passages and is None when every
    question has one; the ranks are the found questions'.
    """
    scored = [q for q in questions if q.error is None]
    n = len(scored)
    found = [q for q in scored if q.found]
    ranks = sorted(q.rank for q in found if q.rank is not None)
    golds_total = sum(q.score.get("golds_total", 0) for q in scored)
    golds_found = sum(q.score.get("golds_found", 0) for q in scored)
    several = any(q.score.get("golds_total", 0) > 1 for q in scored)
    return {
        "total": len(questions),
        "scored": n,
        "found": len(found),
        "hit_rate": len(found) / n if n else None,
        "mrr": sum(1 / q.rank for q in found if q.rank) / n if n else None,
        "recall": golds_found / golds_total if several and golds_total else None,
        "mean_rank": sum(ranks) / len(ranks) if ranks else None,
        "median_rank": float(statistics.median(ranks)) if ranks else None,
    }


def evaluate(
    p: Pipeline,
    questions: str | Path | list[dict] | dict,
    top_k: int = 5,
    documents: Any = None,
    *,
    credentials: dict[str, str] | None = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    cancel: threading.Event | None = None,
) -> EvaluationReport:
    """Search for every question in `questions` and say whether the answer came back.

    `questions` is a question set: a path to a JSON or CSV file in the format
    the bundled samples use, or the same list (or dict) in code. It is checked
    before anything runs. `top_k` is how many of the top pieces count, which
    is what a reader would look at. With `documents` (what `index.run`
    takes), each question searches exactly those documents, indexed first
    through the cache when needed; without it, the search covers what `p.index`
    indexed last. Each question is scored by the `eval` step, the one the
    playground's Evaluate page runs, and a miss is traced down the steps to
    the first one that lost it. A model's key goes in `credentials`, as for
    `p.retrieve`.

    `on_event` gets every event of every search, with the question's id under
    "question", and a "question_finished" event after each question. `cancel`
    stops before the next question; the report then says it was cancelled.
    """
    if top_k < 1:
        raise ValueError(
            "top_k must be at least 1: it is how many of the top pieces are checked for the answer."
        )
    if p.retrieval is None:
        raise ValueError(
            "evaluate needs a pipeline with a retrieve section, because it searches "
            "for every question. Add a retrieve section with at least a search step."
        )
    asked = load_questions(questions)["questions"]
    resolved = p.index._documents(documents) if documents is not None else None
    discover()
    step = registry.get(Stage.USE_CASE, "eval")
    settings = step.config_model(top_k=top_k)
    index: IndexReport | None = None
    results: list[QuestionResult] = []
    cancelled = False
    for n, q in enumerate(asked, start=1):
        if cancel is not None and cancel.is_set():
            cancelled = True
            break
        qid = q["id"] or f"question {n}"
        emit = None
        if on_event is not None:
            def emit(e: dict[str, Any], qid: str = qid) -> None:
                on_event({**e, "question": qid})
        retrieval = p.retrieval._retrieve(
            q["question"], None, resolved, credentials=credentials, on_event=emit, cancel=cancel
        )
        if not retrieval.ok and cancel is not None and cancel.is_set():
            cancelled = True
            break
        common = {"id": qid, "question": q["question"], "golds": q["gold_answers"], "tags": q["tags"]}
        if not retrieval.ok:
            result = QuestionResult(
                **common, found=False, rank=None, lost_at=None, trace=None, score={},
                error=_failure(retrieval), retrieval=retrieval,
            )
        else:
            query = Query(text=q["question"], gold_answers=q["gold_answers"])
            score = step().apply(
                {"result": retrieval.result.model_dump(mode="json"), "query": query.model_dump(mode="json")},
                settings,
                None,
            )["payload"]
            miss = None
            if not score["hit"]:
                if index is None:
                    index = p.index._index(
                        resolved if resolved is not None else p.index.indexed(), remember=False
                    )
                miss = _trace(index, retrieval, q, top_k)
            result = QuestionResult(
                **common, found=score["hit"], rank=score["rank"],
                lost_at=miss["lost_at"] if miss else None, trace=miss, score=score,
                retrieval=retrieval,
            )
        results.append(result)
        if on_event is not None:
            on_event(event(
                "question_finished", question=qid, number=n, total=len(asked),
                found=result.found, error=result.error,
            ))
    return EvaluationReport(top_k=top_k, questions=results, cancelled=cancelled)


def _failure(retrieval: Retrieval) -> str:
    """Which retrieval step failed, and the last line of its error."""
    steps = [retrieval.index, retrieval.stages["rewrite"], retrieval.stages["search"], *retrieval.stages["rerank"]]
    failed = next((s for s in steps if s.status == "failed"), None)
    if failed is None:
        return "Retrieval did not finish."
    lines = (failed.error or "").strip().splitlines()
    return f"The {failed.stage} step ({failed.transform}) failed: {lines[-1] if lines else 'it gave no reason'}"


def _document_for(index: IndexReport, question: dict[str, Any]) -> str:
    """The document a miss is traced in: the one the question names when it
    is indexed, else the first whose pieces hold a gold passage whole, else
    the first whose parsed text holds one, else the first by id."""
    if question.get("document") in index.documents:
        return question["document"]
    golds = question["gold_answers"]
    ids = sorted(index.documents)
    for doc_id in ids:
        step = index.documents[doc_id].stages.get("chunk")
        chunks = step.output if step is not None else None
        if chunks is not None and any(_holds(c.text, golds) for c in ChunkSet.model_validate(chunks).chunks):
            return doc_id
    for doc_id in ids:
        parsed = index.documents[doc_id].stages["parse"].output
        if parsed is not None and _holds(DocView.of(parsed).text, golds):
            return doc_id
    return ids[0]


def _trace(index: IndexReport, retrieval: Retrieval, question: dict[str, Any], top_k: int) -> dict[str, Any]:
    """The miss trace over one document's index steps and the retrieval.

    With several rerankers, the trace checks the last one, whose result the
    eval step scored.
    """
    doc_id = _document_for(index, question)
    stages = index.documents[doc_id].stages
    cleans = sorted((k for k in stages if k.startswith("clean.")), key=lambda k: int(k.split(".")[1]))
    reranks = retrieval.stages["rerank"]
    found = trace(
        golds=question["gold_answers"],
        parse=StepInput(stages["parse"].transform, stages["parse"].output),
        cleans=[StepInput(stages[k].transform, stages[k].output) for k in cleans],
        chunks=stages["chunk"].output,
        retrieve=retrieval.stages["search"].output,
        final=reranks[-1].output if reranks else None,
        rerank_name=reranks[-1].transform if reranks else None,
        top_k=top_k,
    )
    return {**found, "document": doc_id}


#: The stages compare can vary, and the section of the pipeline file each is in.
COMPARE_STAGES: dict[str, str] = {
    "parse": "index",
    "clean": "index",
    "chunk": "index",
    "embed": "index",
    "store": "index",
    "rewrite": "retrieve",
    "search": "retrieve",
    "rerank": "retrieve",
}


@dataclass
class Comparison:
    """One variant: the pipeline with that stage changed, its index run, and
    its evaluation when there were questions."""

    stage: str
    variant: Any
    pipeline: Pipeline
    index: IndexReport
    report: EvaluationReport | None

    @property
    def outputs(self) -> dict[str, StageResult]:
        """The varied step's result: per document for parse, clean (the last
        cleaner) and chunk; under "index" for embed and store; empty for a
        retrieval stage, whose results are in `report`."""
        if self.stage in ("embed", "store"):
            return {"index": self.index.index}
        if COMPARE_STAGES[self.stage] != "index":
            return {}
        out: dict[str, StageResult] = {}
        for doc_id, document in self.index.documents.items():
            keys = [k for k in document.stages if k == self.stage or k.startswith(f"{self.stage}.")]
            if keys:
                out[doc_id] = document.stages[max(keys, key=lambda k: int(k.split(".")[1]) if "." in k else 0)]
        return out

    @property
    def settings(self) -> str:
        """The variant in short: each step's name and the settings it was given."""
        block = _block(self.variant)
        blocks = block if isinstance(block, list) else [block]
        return ", ".join(_short(b) for b in blocks) or "none"

    @property
    def index_stopped(self) -> bool:
        """A cancel stopped the index run: a step was skipped and none failed."""
        steps = [s for d in self.index.documents.values() for s in d.stages.values()]
        if self.index.index is not None:
            steps.append(self.index.index)
        statuses = {s.status for s in steps}
        return "skipped" in statuses and "failed" not in statuses

    @property
    def cancelled(self) -> bool:
        """A cancel stopped this variant, in its index run or its evaluation."""
        if self.report is not None and self.report.cancelled:
            return True
        return not self.index.ok and self.index_stopped

    def __str__(self) -> str:
        """One plain line: the stage, the variant in short, and how it did."""
        if not self.index.ok:
            outcome = "stopped" if self.index_stopped else "the index run failed"
        elif self.report is None:
            outcome = "indexed, no questions asked"
        else:
            t = self.report.totals()
            outcome = f"found {t['found']} of {t['scored']}"
            if self.report.cancelled:
                outcome += " (stopped early)"
        return f"{self.stage} {self.settings}: {outcome}"

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON: the variant, whether its index run worked, each varied
        step's result id and status, and the evaluation."""
        return {
            "stage": self.stage,
            "variant": _block(self.variant),
            "ok": self.index.ok,
            "cancelled": self.cancelled,
            "outputs": {
                key: {"artifact_id": s.artifact_id, "status": s.status, "transform": s.transform}
                for key, s in self.outputs.items()
            },
            "report": self.report.to_dict() if self.report is not None else None,
        }


def _short(block: Any) -> str:
    """One step's block as its name and settings, such as
    "recursive_character chunk_size=800"."""
    if not isinstance(block, dict):
        return str(block)
    settings = " ".join(f"{key}={value}" for key, value in block.items() if key != "use")
    return f"{block.get('use')} {settings}".strip()


class Comparisons(list[Comparison]):
    """What `compare` returns: a list of `Comparison`, one per variant, that
    prints one plain line per variant and the best one. The best has the
    highest hit rate (found out of scored), then the highest mean reciprocal
    rank. A variant a cancel stopped is never the best. A slice such as
    `results[:2]` is a plain list."""

    #: A cancel stopped compare before every variant ran.
    cancelled: bool = False

    def _scored(self) -> list[Comparison]:
        return [
            c for c in self
            if c.report is not None and not c.cancelled and c.report.totals()["scored"]
        ]

    @property
    def best(self) -> list[Comparison]:
        """The best comparisons, every one tied for first, in order; empty when
        no variant finished and was scored, or none found an answer."""
        scored = self._scored()
        if not any(c.report.found for c in scored):
            return []

        def key(c: Comparison) -> tuple[float, float]:
            t = c.report.totals()
            return (t["hit_rate"], t["mrr"])

        top = key(max(scored, key=key))
        return [c for c in scored if key(c) == top]

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON: every comparison's `to_dict()`, and the best as their
        places in the list."""
        best = self.best
        return {
            "comparisons": [c.to_dict() for c in self],
            "best": [n for n, c in enumerate(self) if any(c is b for b in best)],
            "cancelled": self.cancelled,
        }

    def __str__(self) -> str:
        lines = [str(c) for c in self]
        best = self.best
        if best:
            t = best[0].report.totals()
            line = f"Best: {best[0].settings}, found {t['found']} of {t['scored']}"
            if len(best) > 1:
                line += ", tied with " + " and ".join(c.settings for c in best[1:])
            lines.append(line + ".")
        elif self._scored():
            lines.append("No variant found an answer.")
        if self.cancelled or any(c.cancelled for c in self):
            lines.append("Stopped before every variant had finished.")
        return "\n".join(lines)


def compare(
    p: Pipeline,
    stage: str,
    variants: list[Any],
    documents: str | Path | list[str | Path],
    questions: str | Path | list[dict] | dict | None = None,
    *,
    top_k: int = 5,
    credentials: dict[str, str] | None = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    cancel: threading.Event | None = None,
) -> Comparisons:
    """Run `p` once per variant, with only `stage` changed, and evaluate each.

    A variant is what the pipeline file takes for that stage: a block such as
    {"use": "recursive_character", "chunk_size": 800}, a name, a step class,
    or for clean and rerank a list of them. Every variant is checked before
    any runs. Each one indexes `documents` against the same store, so every
    step above the changed one is a cache hit after the first variant. With
    `questions`, each variant is evaluated (see `evaluate`); without them,
    each result holds the changed step's output, and a retrieval stage
    cannot be compared, because nothing is searched. The best variant is the
    one with the highest hit rate (answers found out of questions scored),
    then the highest mean reciprocal rank; see `Comparisons.best`.

    `on_event` gets every event, with the variant's number (from 1) under
    "variant" and the number of variants under "variants"; `cancel` starts no
    further variant, and the result says it was cancelled.
    """
    section = COMPARE_STAGES.get(stage)
    if section is None:
        raise ValueError(
            f"compare varies one of {', '.join(COMPARE_STAGES)}; '{stage}' is not one of them."
        )
    if not variants:
        raise ValueError("compare needs at least one variant: the settings to try at that stage.")
    if section == "retrieve" and questions is None:
        raise ValueError(
            f"Comparing {stage} needs questions: without them nothing is searched, "
            f"so there is no {stage} result to compare."
        )
    asked = load_questions(questions)["questions"] if questions is not None else None
    base = to_dict(p.config)
    pipelines: list[Pipeline] = []
    for n, variant in enumerate(variants, start=1):
        block = _block(copy.deepcopy(variant))
        if stage in ("clean", "rerank") and isinstance(block, dict):
            block = [block]
        data = copy.deepcopy(base)
        data.setdefault(section, {})[stage] = block
        try:
            pipelines.append(Pipeline._of(from_dict(data, base=p.config.path)))
        except ConfigError as exc:
            raise ConfigError(f"variant {n}: {exc}") from None
    results = Comparisons()
    for n, (variant, pipeline) in enumerate(zip(variants, pipelines), start=1):
        if cancel is not None and cancel.is_set():
            results.cancelled = True
            break
        emit = None
        if on_event is not None:
            def emit(e: dict[str, Any], n: int = n) -> None:
                on_event({**e, "variant": n, "variants": len(variants)})
        index = pipeline.index.run(documents, on_event=emit, cancel=cancel, credentials=credentials)
        report = None
        if asked is not None and index.ok:
            report = evaluate(
                pipeline, asked, top_k, credentials=credentials, on_event=emit, cancel=cancel
            )
            results.cancelled = results.cancelled or report.cancelled
        results.append(Comparison(stage=stage, variant=variant, pipeline=pipeline, index=index, report=report))
        if cancel is not None and cancel.is_set():
            results.cancelled = True
            break
    return results
