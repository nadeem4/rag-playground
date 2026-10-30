"""POST /ask: search the documents for a question, or answer it, as a run."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Request
from pandion import check_where
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from pandion_api import reports
from pandion_api.jobs import SortedIn, assign_to, documents_of, start
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


#: The largest page number: the index keeps pages as 32-bit whole numbers.
MAX_PAGE = 2**31 - 1
Page = Annotated[StrictInt, Field(ge=1, le=MAX_PAGE)]


class WhereIn(BaseModel):
    """A search filter: only these documents, pages or section. See the
    package's `pandion.filters` for the rules; this checks the same ones."""

    model_config = ConfigDict(extra="forbid")

    #: Documents by sha; each must be one of the request's documents.
    document: list[StrictStr] | None = None
    #: First page and last page, both included.
    pages: tuple[Page, Page] | None = None
    #: A heading on the piece's heading path, matched exactly.
    section: StrictStr | None = None

    @model_validator(mode="after")
    def _same_rules_as_the_package(self) -> "WhereIn":
        check_where(self.model_dump(exclude_none=True))
        return self


class AskIn(SortedIn):
    config: Any
    documents: list[str] = Field(min_length=1)
    question: str = Field(min_length=1, max_length=2000)
    #: How many hits the last retrieval step keeps; the pipeline's own top_k when left out.
    k: int | None = Field(default=None, ge=1, le=100)
    #: False: search only, no answer step.
    answer: bool = True
    force: bool = False
    #: Search only some documents, pages or a section. Left out, the search covers every document.
    where: WhereIn | None = None


@router.post("/ask", status_code=202)
async def ask(body: AskIn, request: Request) -> dict[str, str]:
    """Search the documents for the question, then answer it unless `answer` is
    false. The documents are indexed first, through the cache, when needed."""
    p = prepare(body.config, request)
    if p.retrieval is None:
        raise problems(NO_SEARCH)
    if body.answer and p.query is None:
        raise problems(NO_ANSWER)
    where = body.where.model_dump(exclude_none=True) if body.where is not None else None
    for sha in (where or {}).get("document", []):
        if sha not in body.documents:
            raise problems(f"where: document {sha} is not one of the documents sent with the question.")
    documents = documents_of(body.documents, request)
    assign_to(p, body, list(documents))

    def work(on_event, cancel, credentials):
        options = {
            "documents": documents,
            "where": where,
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
