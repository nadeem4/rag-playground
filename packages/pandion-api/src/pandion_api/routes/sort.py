"""POST /pipelines/sort: which category each document would get, and why."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import Field

from pandion_api.documents import route_id
from pandion_api.jobs import SortedIn, assign_to, documents_of
from pandion_api.pipelines import prepare, problems

router = APIRouter()


class SortIn(SortedIn):
    config: Any
    documents: list[str] = Field(min_length=1)


@router.post("/pipelines/sort")
def sort(body: SortIn, request: Request) -> dict[str, Any]:
    """The category each document would go to and the reason, by sha. Nothing
    runs. A pin (`categories`) and labels (`metadata`) count as in a run, and a
    URL document is read by the link it was fetched from."""
    p = prepare(body.config, request)
    documents = documents_of(body.documents, request)
    store = request.app.state.documents
    ids = {sha: route_id(store, sha, name) for sha, name in zip(body.documents, documents)}
    assign_to(p, body, list(ids.values()))
    try:
        sorted_ = p.index.sort({ids[sha]: documents[name] for sha, name in zip(body.documents, documents)})
    except ValueError as exc:
        raise problems(str(exc)) from None
    return {
        "documents": {
            sha: {"category": sorted_[ids[sha]].category, "reason": sorted_[ids[sha]].reason}
            for sha in body.documents
        }
    }
