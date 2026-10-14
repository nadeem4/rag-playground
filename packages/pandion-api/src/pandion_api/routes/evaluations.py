"""Part 2's features over HTTP: evaluate a pipeline on a question set, and
compare the settings of one stage. Both are runs, started through the same
path as index runs and questions (`pandion_api.jobs.start`): the same owner,
the same scrub, the same queue.

A question set comes from the request, held to the same caps as an uploaded
one, or, when the request sends none, from the sets kept against its documents
(POST /documents/{id}/questions).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from pandion import compare, evaluate
from pandion.evaluation import COMPARE_STAGES, QuestionSetError, parse_question_set
from pandion_api.jobs import documents_of, start
from pandion_api.pipelines import NOT_A_MAPPING, prepare, problems, variant_config
from pandion_api.routes.ask import NO_SEARCH
from pandion_api.routes.questions import MAX_GOLDS, MAX_QUESTIONS, MAX_SET_BYTES, TOO_BIG

router = APIRouter()

#: A question set in the format the bundled samples use: a list, or an object with "questions".
QuestionSet = list[dict[str, Any]] | dict[str, Any]

NO_QUESTIONS = (
    "There are no questions to ask: send a question set in questions, or keep one "
    "against the document first (POST /documents/{id}/questions)."
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


def _kept(shas: list[str], request: Request) -> list[dict[str, Any]]:
    """The questions of the sets kept against these documents, in their order."""
    store = request.app.state.documents
    out: list[dict[str, Any]] = []
    for sha in shas:
        kept = store.questions(sha)
        if kept.is_file():
            out.extend(json.loads(kept.read_text(encoding="utf-8"))["set"]["questions"])
    return out


async def question_set(questions: QuestionSet | None, shas: list[str], request: Request) -> list[dict[str, Any]]:
    """The questions a run asks; empty when there are none. Off the event loop."""
    if questions is not None:
        return await run_in_threadpool(_checked, questions)
    return await run_in_threadpool(_kept, shas, request)


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
    questions = await question_set(body.questions, body.documents, request)
    if not questions:
        raise HTTPException(status_code=400, detail=NO_QUESTIONS)

    def work(on_event, cancel, credentials):
        report = evaluate(
            p, questions, top_k=body.top_k, documents=documents,
            credentials=credentials, on_event=on_event, cancel=cancel,
        )
        ok = not report.cancelled and all(q.error is None for q in report.questions)
        return ok, report.cancelled, report.to_dict()

    return start(request, "evaluation", work)


class ComparisonIn(BaseModel):
    config: Any
    #: The stage that varies: parse, clean, chunk, embed, store, rewrite, search or rerank.
    stage: str
    #: What the pipeline file takes for that stage, once per variant (a list for clean and rerank).
    variants: list[Any] = Field(min_length=1)
    documents: list[str] = Field(min_length=1)
    #: Left out: the sets kept against the documents, if any.
    questions: QuestionSet | None = None
    top_k: int = Field(default=5, ge=1, le=50)


@router.post("/comparisons", status_code=202)
async def create_comparison(body: ComparisonIn, request: Request) -> dict[str, str]:
    """Run the pipeline once per variant of one stage, against the same store, so
    every step above the changed one is a cache hit after the first; evaluate
    each when there are questions. The Policy caps the number of variants
    (`Policy.max_variants`), which bounds the work one request can ask for."""
    if body.stage not in COMPARE_STAGES:
        raise HTTPException(
            status_code=400,
            detail=f"stage names the step to compare: one of {', '.join(COMPARE_STAGES)}, not '{body.stage}'.",
        )
    most = request.app.state.policy.max_variants(request)
    if len(body.variants) > most:
        raise problems(f"A comparison runs at most {most} variants; this one has {len(body.variants)}.")
    if not isinstance(body.config, dict):
        raise problems(NOT_A_MAPPING)
    p = prepare(body.config, request)
    for variant in body.variants:
        prepare(variant_config(body.config, body.stage, variant), request)
    documents = documents_of(body.documents, request)
    questions = await question_set(body.questions, body.documents, request) or None
    if COMPARE_STAGES[body.stage] == "retrieve" and questions is None:
        raise HTTPException(
            status_code=400,
            detail=f"A {body.stage} step can only be compared with questions: without them nothing is searched.",
        )

    def work(on_event, cancel, credentials):
        results = compare(
            p, body.stage, body.variants, documents, questions,
            top_k=body.top_k, credentials=credentials, on_event=on_event, cancel=cancel,
        )
        stopped = len(results) < len(body.variants)
        return not stopped and all(c.index.ok for c in results), stopped, results.to_dict()

    return start(request, "comparison", work)
