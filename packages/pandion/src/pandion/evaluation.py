"""Evaluate a pipeline on a question set, and compare settings: the public names.

A question set is the JSON format the bundled samples use (a list of
questions, or an object with a "questions" list), or a CSV file with the same
columns, or the same list in code. Each question has `question` and at least
one gold passage (`gold_answer` or `gold_answers`): the sentence in the
document that answers it. `id`, `answer`, `tags` and `document` are optional.
`trace` follows one question's answer down a finished run and says the first step
that lost it. `evaluate` asks every question in a set and runs `trace` for every miss.
See docs/pandion.md, "Evaluate a pipeline".
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pandion.payloads import Query
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
from pandion.trace import StepInput, _holds, trace

__all__ = [
    "EvaluationReport",
    "GOLD_SEPARATOR",
    "QuestionResult",
    "QuestionSetError",
    "StepInput",
    "check_questions",
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

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON, without the retrieval."""
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
        }


@dataclass
class EvaluationReport:
    """Every question's verdict, at `top_k` pieces checked, and the totals."""

    top_k: int
    questions: list[QuestionResult]

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

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON: the totals, the totals by tag, and every question."""
        return {
            "top_k": self.top_k,
            **self.totals(),
            "by_tag": self.by_tag(),
            "questions": [q.to_dict() for q in self.questions],
        }


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
    documents: str | Path | list[str | Path] | None = None,
    *,
    credentials: dict[str, str] | None = None,
) -> EvaluationReport:
    """Search for every question in `questions` and say whether the answer came back.

    `questions` is a question set: a path to a JSON or CSV file in the format
    the bundled samples use, or the same list (or dict) in code. It is checked
    before anything runs. `top_k` is how many of the top pieces count, which
    is what a reader would look at. With `documents` (what `index.run`
    takes), those documents are indexed first, every step a cache hit when
    they were indexed before, and the search covers exactly them; without
    it, the search covers what `p.index` indexed last. Each question is
    scored by the `eval` step, the one the playground's Evaluate page runs,
    and a miss is traced down the steps to the first one that lost it.
    A model's key goes in `credentials`, as for `p.retrieve`.
    """
    if top_k < 1:
        raise ValueError(
            "top_k must be at least 1: it is how many of the top pieces are checked for the answer."
        )
    if p.retrieval is None:
        raise ValueError(
            "evaluate needs a pipeline with a retrieve section, because it searches "
            "for every question. Add retrieve: with at least a search step."
        )
    asked = load_questions(questions)["questions"]
    if documents is not None:
        p.index.run(documents)
    discover()
    step = registry.get(Stage.USE_CASE, "eval")
    settings = step.config_model(top_k=top_k)
    index: IndexReport | None = None
    results: list[QuestionResult] = []
    for q in asked:
        retrieval = p.retrieve(q["question"], credentials=credentials)
        common = {"id": q["id"], "question": q["question"], "golds": q["gold_answers"], "tags": q["tags"]}
        if not retrieval.ok:
            results.append(QuestionResult(
                **common, found=False, rank=None, lost_at=None, trace=None, score={},
                error=_failure(retrieval), retrieval=retrieval,
            ))
            continue
        query = Query(text=q["question"], gold_answers=q["gold_answers"])
        score = step().apply(
            {"result": retrieval.result.model_dump(mode="json"), "query": query.model_dump(mode="json")},
            settings,
            None,
        )["payload"]
        miss = None
        if not score["hit"]:
            if index is None:
                index = p.index._index(p.index.indexed())
            miss = _trace(index, retrieval, q, top_k)
        results.append(QuestionResult(
            **common, found=score["hit"], rank=score["rank"],
            lost_at=miss["lost_at"] if miss else None, trace=miss, score=score,
            retrieval=retrieval,
        ))
    return EvaluationReport(top_k=top_k, questions=results)


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
    is indexed, else the first whose parsed text holds a gold passage, else
    the first by id."""
    if question.get("document") in index.documents:
        return question["document"]
    ids = sorted(index.documents)
    for doc_id in ids:
        parsed = index.documents[doc_id].stages["parse"].output
        if parsed is not None and _holds(DocView.of(parsed).text, question["gold_answers"]):
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
