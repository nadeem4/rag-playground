"""POST /pipelines/sort: which category each document would get, and why."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import Field

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
    URL document is named and read as in a run, with its link as the path."""
    p = prepare(body.config, request)
    documents = documents_of(body.documents, request)
    assign_to(p, body, list(documents), request)
    try:
        sorted_ = p.index.sort(documents)
    except ValueError as exc:
        raise problems(str(exc)) from None
    return {
        "documents": {
            sha: {"category": sorted_[name].category, "reason": sorted_[name].reason}
            for sha, name in zip(body.documents, documents)
        }
    }
