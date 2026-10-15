"""Part 2's features over HTTP: evaluate a pipeline on a question set, and
compare the settings of one stage. Both are runs, started through the same
path as index runs and questions (`pandion_api.jobs.start`): the same owner,
the same scrub, the same queue.

An evaluation's question set comes from the request, held to the same caps as
an uploaded one, or, when the request sends none, from the sets kept against
its documents (POST /documents/{id}/questions). A comparison asks only the
questions the request sends; without them it is index only, as `pandion.compare` is.
With one question and no gold passage (`question`), each variant searches (or
answers) it and the results come back unscored.
"""

from __future__ import annotations

import json
import threading
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from pandion import compare, evaluate
from pandion.evaluation import COMPARE_STAGES, QuestionSetError, parse_question_set
from pandion_api import reports
from pandion_api.jobs import documents_of, start
from pandion_api.pipelines import NOT_A_MAPPING, prepare, problems, variant_config
from pandion_api.routes.ask import NO_ANSWER, NO_SEARCH
from pandion_api.routes.questions import MAX_GOLDS, MAX_QUESTIONS, MAX_SET_BYTES, TOO_BIG

router = APIRouter()

#: A question set in the format the bundled samples use: a list, or an object with "questions".
QuestionSet = list[dict[str, Any]] | dict[str, Any]

NO_QUESTIONS = (
    "There are no questions to ask: send a question set in questions, or keep one "
    "against the document first (POST /documents/{id}/questions)."
)

ONE_OR_THE_OTHER = (
    "Send questions (a question set, to score each variant) or question (one "
    "question, to see each variant's results), not both."
)
NO_THROUGH_WITH_QUESTION = (
    "through stops an index-only comparison after a step; a comparison on one "
    "question searches, so send question or through, not both."
)
ANSWER_NEEDS_QUESTION = (
    "answer goes on to the answer step for one question, so it needs question; "
    "a comparison with questions scores the search and has no answer step."
)


def _checked(questions: QuestionSet) -> list[dict[str, Any]]:
    """The request's set, parsed with an upload's caps: 413 past MAX_SET_BYTES,
    400 with the set's own sentence when it cannot be used."""
    data = json.dumps(questions).encode("utf-8")
    if len(data) > MAX_SET_BYTES:
        raise HTTPException(status_code=413, detail=TOO_BIG)
    try:
        parsed = parse_question_set(
            data, one_document=False, max_questions=MAX_QUESTIONS, max_golds=MAX_GOLDS
        )
    except QuestionSetError as exc:
        raise HTTPException(
            status_code=400, detail=f"The question set cannot be used: {str(exc).rstrip('.')}."
        ) from None
    return parsed["questions"]


def _kept(shas: list[str], names: list[str], request: Request) -> list[dict[str, Any]]:
    """The questions of the sets kept against these documents, in their order.
    An id two documents' sets both use is prefixed with each document's name,
    so every question stays apart; together they hold at most MAX_QUESTIONS."""
    store = request.app.state.documents
    sets: list[tuple[str, list[dict[str, Any]]]] = []
    for sha, name in zip(shas, names):
        kept = store.questions(sha)
        if kept.is_file():
            sets.append((name, json.loads(kept.read_text(encoding="utf-8"))["set"]["questions"]))
    total = sum(len(qs) for _, qs in sets)
    if total > MAX_QUESTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"The sets kept against these documents hold {total} questions together; "
            f"at most {MAX_QUESTIONS} fit in one run, so evaluate fewer documents at once.",
        )
    owners: dict[str, set[str]] = {}
    for name, qs in sets:
        for q in qs:
            if q.get("id"):
                owners.setdefault(q["id"], set()).add(name)
    return [
        {**q, "id": f"{name}: {q['id']}"} if q.get("id") and len(owners[q["id"]]) > 1 else q
        for name, qs in sets
        for q in qs
    ]


class EvaluationIn(BaseModel):
    config: Any
    documents: list[str] = Field(min_length=1)
    #: Left out: the sets kept against the documents.
    questions: QuestionSet | None = None
    top_k: int = Field(default=5, ge=1, le=50)


@router.post("/evaluations", status_code=202)
async def create_evaluation(body: EvaluationIn, request: Request) -> dict[str, str]:
    """Search for every question and say whether its answer came back, and for a
    miss, the first step that lost it."""
    p = prepare(body.config, request)
    if p.retrieval is None:
        raise problems(NO_SEARCH)
    documents = documents_of(body.documents, request)
    if body.questions is not None:
        questions = await run_in_threadpool(_checked, body.questions)
    else:
        questions = await run_in_threadpool(_kept, body.documents, list(documents), request)
    if not questions:
        raise HTTPException(status_code=400, detail=NO_QUESTIONS)
    request.app.state.policy.check_question_count("evaluation", len(questions), request)

    def work(on_event, cancel, credentials):
        report = evaluate(
            p, questions, top_k=body.top_k, documents=documents,
            credentials=credentials, on_event=on_event, cancel=cancel,
        )
        ok = not report.cancelled and all(q.error is None for q in report.questions)
        return ok, report.cancelled, reports.evaluation(report)

    return start(request, "evaluation", work)


def _check_through(p: Any, body: "ComparisonIn", documents: dict[str, str], questions: Any) -> None:
    """Pandion's own check of `through`, run before the run starts: compare
    checks every argument first and, with `cancel` already set, starts no
    variant, so nothing is indexed. A refusal is a 400 with its sentence."""
    stopped = threading.Event()
    stopped.set()
    try:
        compare(
            p, body.stage, body.variants, documents, questions,
            top_k=body.top_k, cancel=stopped, through=body.through,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


class ComparisonIn(BaseModel):
    config: Any
    #: The stage that varies: parse, clean, chunk, embed, store, rewrite, search or rerank.
    stage: str
    #: What the pipeline file takes for that stage, once per variant (a list for clean and rerank).
    variants: list[Any] = Field(min_length=1)
    documents: list[str] = Field(min_length=1)
    #: Left out: index only, nothing is asked.
    questions: QuestionSet | None = None
    top_k: int = Field(default=5, ge=1, le=50)
    #: Without questions, the step each variant's index run stops after, as for POST /runs.
    through: str | None = None
    #: One question with no gold passage: each variant's results, unscored.
    question: str | None = Field(default=None, min_length=1, max_length=2000)
    #: With question: go on to the answer step, not only the search.
    answer: bool = False


@router.post("/comparisons", status_code=202)
async def create_comparison(body: ComparisonIn, request: Request) -> dict[str, str]:
    """Run the pipeline once per variant of one stage, against the same store, so
    every step above the changed one is a cache hit after the first; evaluate
    each when there are questions. The Policy caps the number of variants
    (`Policy.max_variants`) and the variants times the questions
    (`Policy.check_question_count`), which bounds the work one request can ask for."""
    if body.stage not in COMPARE_STAGES:
        raise HTTPException(
            status_code=400,
            detail=f"stage names the step to compare: one of {', '.join(COMPARE_STAGES)}, not '{body.stage}'.",
        )
    most = request.app.state.policy.max_variants(request)
    if len(body.variants) > most:
        raise problems(f"A comparison runs at most {most} variants; this one has {len(body.variants)}.")
    if body.question is not None and body.questions is not None:
        raise HTTPException(status_code=400, detail=ONE_OR_THE_OTHER)
    if body.question is not None and body.through is not None:
        raise HTTPException(status_code=400, detail=NO_THROUGH_WITH_QUESTION)
    if body.answer and body.question is None:
        raise HTTPException(status_code=400, detail=ANSWER_NEEDS_QUESTION)
    if not isinstance(body.config, dict):
        raise problems(NOT_A_MAPPING)
    # Reading and checking every variant's pipeline is Pandion's work: off the loop.
    p, *prepared = await run_in_threadpool(
        lambda: [prepare(body.config, request)]
        + [prepare(variant_config(body.config, body.stage, v), request) for v in body.variants]
    )
    if COMPARE_STAGES[body.stage] == "retrieve" and body.questions is None and body.question is None:
        raise HTTPException(
            status_code=400,
            detail=f"A {body.stage} step can only be compared with questions: without them nothing is searched.",
        )
    asks = body.questions is not None or body.question is not None
    if asks and any(v.retrieval is None for v in [p, *prepared]):
        raise problems(NO_SEARCH)
    if body.question is not None and body.answer and any(v.query is None for v in prepared):
        raise problems(NO_ANSWER)
    documents = documents_of(body.documents, request)
    questions = await run_in_threadpool(_checked, body.questions) if body.questions is not None else None
    if questions is not None:
        request.app.state.policy.check_question_count("comparison", len(body.variants) * len(questions), request)
    if body.question is not None:
        return start(request, "comparison", _compare_on_one_question(body, prepared, documents))
    if body.through is not None:
        await run_in_threadpool(_check_through, p, body, documents, questions)

    def work(on_event, cancel, credentials):
        results = compare(
            p, body.stage, body.variants, documents, questions, top_k=body.top_k,
            credentials=credentials, on_event=on_event, cancel=cancel, through=body.through,
        )
        stopped = len(results) < len(body.variants)
        return not stopped and all(c.index.ok for c in results), stopped, reports.comparisons(results)

    return start(request, "comparison", work)


def _compare_on_one_question(body: ComparisonIn, pipelines: list, documents: dict):
    """Each variant's retrieve (or ask) on one question, in order. Nothing is
    scored, because there is no gold passage to look for."""

    def work(on_event, cancel, credentials):
        out: list[dict[str, Any]] = []
        stopped = False
        for n, (variant, p) in enumerate(zip(body.variants, pipelines), start=1):
            if cancel.is_set():
                stopped = True
                break

            def emit(e: dict[str, Any], n: int = n) -> None:
                on_event({**e, "variant": n, "variants": len(body.variants)})

            kwargs = dict(documents=documents, credentials=credentials, on_event=emit, cancel=cancel)
            if body.answer:
                a = p.ask(body.question, **kwargs)
                item, ok, cost = {"answer": reports.answer(a)}, a.ok, a.cost()
            else:
                r = p.retrieve(body.question, **kwargs)
                item, ok, cost = {"retrieval": reports.retrieval(r)}, r.ok, r.cost()
            out.append({
                "stage": body.stage, "variant": variant, "ok": ok, "cancelled": cancel.is_set(),
                **item, "cost": cost,
            })
        stopped = stopped or cancel.is_set()
        ok = not stopped and all(c["ok"] for c in out)
        return ok, stopped, {"comparisons": out, "best": [], "cancelled": stopped, "cost": reports.total([c["cost"] for c in out])}

    return work
