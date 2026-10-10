"""Why did this miss? One question's answer followed down a finished run."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from api.routes.artifacts import _require
from api.trace import StepInput, trace
from core.storage import Store

router = APIRouter()


class NamedArtifact(BaseModel):
    id: str
    name: str


class TraceRequest(BaseModel):
    gold_answers: list[str]
    parse: NamedArtifact
    cleans: list[NamedArtifact] = []
    chunk: str
    retrieve: str
    #: The result the eval step scored: the reranker's when there is one.
    final: str
    rerank_name: str | None = None
    top_k: int = 5


@router.post("/trace")
def post_trace(body: TraceRequest, request: Request) -> dict[str, Any]:
    store: Store = request.app.state.deps.store

    def load(artifact_id: str) -> Any:
        _require(store, artifact_id)
        return store.load(artifact_id, store.get_meta(artifact_id).type)

    if not any(g.strip() for g in body.gold_answers):
        raise HTTPException(status_code=422, detail="the question has no answer sentence to look for")
    reranked = body.rerank_name is not None and body.final != body.retrieve
    return trace(
        golds=body.gold_answers,
        parse=StepInput(body.parse.name, load(body.parse.id)),
        cleans=[StepInput(c.name, load(c.id)) for c in body.cleans],
        chunks=load(body.chunk),
        retrieve=load(body.retrieve),
        final=load(body.final) if reranked else None,
        rerank_name=body.rerank_name if reranked else None,
        top_k=body.top_k,
    )
