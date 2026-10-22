"""A stored result by its id, several chunk sets summed up, clearing every stored result, and the miss trace."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import pandion
from pandion import ResultStore
from pandion.evaluation import StepInput, trace
from pandion_api.deps import get_policy, get_runs, get_settings
from pandion_api.policy import Policy
from pandion_api.runs import RunManager
from pandion_api.settings import ApiSettings

router = APIRouter()


def _results(settings: ApiSettings) -> ResultStore:
    return ResultStore(settings.data_dir)


def _info(store: ResultStore, result_id: str) -> dict[str, Any]:
    try:
        return store.info(result_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown result {result_id}") from None


@router.get("/results/{result_id}")
def get_result(result_id: str, settings: ApiSettings = Depends(get_settings)) -> dict[str, Any]:
    """The result's id, its type, and the meta its step left."""
    return _info(_results(settings), result_id)


@router.get("/results/{result_id}/payload")
def get_payload(result_id: str, settings: ApiSettings = Depends(get_settings)) -> Any:
    """The result itself. An index is a folder of files, so its payload is the
    description its store left in its meta, when it left one. A chunk set
    comes with `stats`, its numbers as `pandion.chunk.stats` sums them up."""
    store = _results(settings)
    info = _info(store, result_id)
    if info["type"] == "index":
        descriptor = info["meta"].get("index_descriptor")
        if descriptor is None:
            raise HTTPException(status_code=404, detail="This index result has no description to show.")
        return descriptor
    payload = store.get(result_id)
    if info["type"] == "chunk_set" and isinstance(payload, dict):
        return {**payload, "stats": pandion.chunk.stats(payload)}
    return payload


class ChunkStatsIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=50)


@router.post("/chunk-stats")
def post_chunk_stats(body: ChunkStatsIn, settings: ApiSettings = Depends(get_settings)) -> dict[str, Any]:
    """Several chunk sets, one chunker's over several documents, summed up as one
    by `pandion.chunk.stats`: counts are totals, sizes are over every piece."""
    store = _results(settings)
    for result_id in body.ids:
        found = _info(store, result_id)["type"]
        if found != "chunk_set":
            raise HTTPException(status_code=422, detail=f"{result_id} is a {found}, not a chunk_set.")
    return pandion.chunk.stats(*(store.get(i) for i in body.ids))


@router.delete("/cache")
def clear_cache(
    request: Request,
    settings: ApiSettings = Depends(get_settings),
    policy: Policy = Depends(get_policy),
    runs: RunManager = Depends(get_runs),
) -> dict[str, Any]:
    """Remove every stored result and the embedding cache. The documents stay."""
    policy.check_clear_cache(request)
    if runs.active():
        raise HTTPException(status_code=409, detail="a run is in progress")
    return _results(settings).clear()


class NamedResult(BaseModel):
    id: str
    name: str


class TraceIn(BaseModel):
    gold_answers: list[str] = Field(max_length=50)
    parse: NamedResult
    cleans: list[NamedResult] = Field(default=[], max_length=50)
    chunk: str
    retrieve: str
    #: The result the answer was checked in: the last reranker's when there is one.
    final: str
    rerank_name: str | None = None
    top_k: int = Field(default=5, ge=1, le=100)


@router.post("/trace")
def post_trace(body: TraceIn, settings: ApiSettings = Depends(get_settings)) -> dict[str, Any]:
    """Why did this miss? One question's answer followed down a finished run's results."""
    store = _results(settings)

    def load(result_id: str, role: str, kind: str) -> Any:
        found = _info(store, result_id)["type"]
        if found != kind:
            raise HTTPException(status_code=422, detail=f"The {role} result is a {found}, not a {kind}.")
        return store.get(result_id)

    if not any(g.strip() for g in body.gold_answers):
        raise HTTPException(status_code=422, detail="the question has no answer sentence to look for")
    reranked = body.rerank_name is not None and body.final != body.retrieve
    return trace(
        golds=body.gold_answers,
        parse=StepInput(body.parse.name, load(body.parse.id, "parse", "parsed_doc")),
        cleans=[StepInput(c.name, load(c.id, "clean", "parsed_doc")) for c in body.cleans],
        chunks=load(body.chunk, "chunk", "chunk_set"),
        retrieve=load(body.retrieve, "retrieve", "retrieval_result"),
        final=load(body.final, "final", "retrieval_result") if reranked else None,
        rerank_name=body.rerank_name if reranked else None,
        top_k=body.top_k,
    )
