"""POST /ask: search the documents for a question, or answer it, as a run."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from pandion_api import reports
from pandion_api.jobs import documents_of, start
from pandion_api.pipelines import prepare, problems

router = APIRouter()

NO_SEARCH = (
    "The pipeline has no retrieve section, so there is nothing to search with. "
    "Add a retrieve section with at least a search step."
)
NO_ANSWER = (
    "The pipeline has no answer section, so there is nothing to answer with. "
    "Add answer: with any answer strategy, for example search or chat, or send answer: false to only search."
)


class AskIn(BaseModel):
    config: Any
    documents: list[str] = Field(min_length=1)
    question: str = Field(min_length=1, max_length=2000)
    #: How many hits the last retrieval step keeps; the pipeline's own top_k when left out.
    k: int | None = Field(default=None, ge=1, le=100)
    #: False: search only, no answer step.
    answer: bool = True
    force: bool = False


@router.post("/ask", status_code=202)
async def ask(body: AskIn, request: Request) -> dict[str, str]:
    """Search the documents for the question, then answer it unless `answer` is
    false. The documents are indexed first, through the cache, when needed."""
    p = prepare(body.config, request)
    if p.retrieval is None:
        raise problems(NO_SEARCH)
    if body.answer and p.query is None:
        raise problems(NO_ANSWER)
    documents = documents_of(body.documents, request)

    def work(on_event, cancel, credentials):
        options = {
            "documents": documents,
            "credentials": credentials,
            "on_event": on_event,
            "cancel": cancel,
            "force": body.force,
        }
        if body.answer:
            answered = p.ask(body.question, body.k, **options)
            return answered.ok, False, reports.answer(answered)
        found = p.retrieve(body.question, body.k, **options)
        return found.ok, False, reports.retrieval(found)

    return start(request, "ask" if body.answer else "retrieve", work)
