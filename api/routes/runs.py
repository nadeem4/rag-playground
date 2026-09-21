"""Runs and sweeps: create by POST, stream by GET (EventSource is GET-only).

Requests are validated *before* a run is created: an invalid graph is a 400 and
an invalid node config a 422, rather than a run that dies in its worker thread.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from api.runs import RunState
from core.executor import run, sweep
from core.graph import Edge, Graph, GraphValidationError, Node
from core.ports import Stage
from core.registry import Registry, UnknownTransformError

router = APIRouter()

#: Seconds between SSE comment heartbeats on an idle stream.
HEARTBEAT_S = 15.0

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


class NodeIn(BaseModel):
    id: str
    stage: Stage
    transform: str
    config: dict[str, Any] = Field(default_factory=dict)


class EdgeIn(BaseModel):
    src: str
    dst: str
    port: str


class GraphIn(BaseModel):
    nodes: list[NodeIn]
    edges: list[EdgeIn] = Field(default_factory=list)

    def to_graph(self) -> Graph:
        return Graph(
            nodes=[Node(n.id, n.stage, n.transform, n.config) for n in self.nodes],
            edges=[Edge(e.src, e.dst, e.port) for e in self.edges],
        )


class RunIn(BaseModel):
    graph: GraphIn
    overrides: dict[str, dict[str, Any]] | None = None
    targets: list[str] | None = None
    force: bool = False


class VariantIn(BaseModel):
    transform: str
    config: dict[str, Any] = Field(default_factory=dict)


class SweepIn(BaseModel):
    graph: GraphIn
    node_id: str
    variants: list[VariantIn] = Field(min_length=1)
    through: str | None = None
    force: bool = False


def _check(graph: Graph, registry: Registry, overrides: dict | None = None) -> None:
    """Raise the HTTP error a run would otherwise hit in its worker thread."""
    try:
        graph.validate(registry)
    except GraphValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    overrides = overrides or {}
    for nd in graph.nodes:
        cls = registry.get(nd.stage, nd.transform)
        try:
            cls.config_model(**overrides.get(nd.id, nd.config))
        except ValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"node_id": nd.id, "errors": json.loads(exc.json())},
            ) from exc


def _unknown(graph: Graph, ids: list[str], what: str) -> None:
    known = {nd.id for nd in graph.nodes}
    missing = [i for i in ids if i not in known]
    if missing:
        raise HTTPException(status_code=400, detail=f"unknown {what}: {missing}")


@router.post("/runs", status_code=202)
async def create_run(body: RunIn, request: Request) -> dict[str, str]:
    deps = request.app.state.deps
    graph = body.graph.to_graph()
    _check(graph, deps.registry, body.overrides)
    _unknown(graph, body.targets or [], "target")

    def job(emit, cancelled):
        seen: list[bool] = []

        def on_event(e):
            if e["event"] == "run_cancelled":
                seen.append(True)
            emit(e)

        res = run(
            graph,
            deps.registry,
            deps.store,
            overrides=body.overrides,
            targets=set(body.targets) if body.targets else None,
            force=body.force,
            on_event=on_event,
            cancelled=cancelled,
        )
        return res.ok, bool(seen)

    state = request.app.state.runs.start("run", job)
    return {"run_id": state.run_id}


@router.post("/sweeps", status_code=202)
async def create_sweep(body: SweepIn, request: Request) -> dict[str, str]:
    deps = request.app.state.deps
    graph = body.graph.to_graph()
    _unknown(graph, [body.node_id] + ([body.through] if body.through else []), "node")
    target = graph.node(body.node_id)
    for v in body.variants:
        try:
            deps.registry.get(target.stage, v.transform)
        except UnknownTransformError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"unknown transform {target.stage}/{v.transform}",
            ) from exc
        variant_graph = Graph(
            nodes=[
                Node(nd.id, nd.stage, v.transform, v.config)
                if nd.id == body.node_id
                else nd
                for nd in graph.nodes
            ],
            edges=graph.edges,
        )
        _check(variant_graph, deps.registry)
    variants = [{"transform": v.transform, "config": v.config} for v in body.variants]

    def job(emit, cancelled):
        seen: list[bool] = []

        def on_event(e):
            if e["event"] == "run_cancelled":
                seen.append(True)
            emit(e)

        res = sweep(
            graph,
            deps.registry,
            deps.store,
            node_id=body.node_id,
            variants=variants,
            through=body.through,
            force=body.force,
            on_event=on_event,
            cancelled=cancelled,
        )
        stopped_early = len(res.runs) < len(variants)
        return all(r.ok for r in res.runs), bool(seen) or stopped_early

    state = request.app.state.runs.start("sweep", job)
    return {"run_id": state.run_id}


def _state(request: Request, run_id: str) -> RunState:
    state = request.app.state.runs.get(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")
    return state


@router.get("/runs/{run_id}")
def get_run(run_id: str, request: Request) -> dict[str, Any]:
    return _state(request, run_id).snapshot()


@router.post("/runs/{run_id}/cancel", status_code=202)
def cancel_run(run_id: str, request: Request):
    state = _state(request, run_id)
    if state.done:
        return JSONResponse(
            status_code=409,
            content={"detail": f"run already {state.status}", "status": state.status},
        )
    request.app.state.runs.cancel(state)
    return {
        "run_id": run_id,
        "cancel_requested": True,
        "detail": (
            "Cancellation is checked between nodes: the node currently running "
            "will finish, and no further nodes will start."
        ),
    }


def _frame(seq: int, e: dict[str, Any]) -> str:
    # json.dumps escapes newlines, so one event is always one `data:` line.
    return f"id: {seq}\ndata: {json.dumps(e)}\n\n"


@router.get("/runs/{run_id}/events")
async def run_events(
    run_id: str,
    request: Request,
    last_event_id: str | None = Header(default=None),
):
    state = _state(request, run_id)
    try:
        start = int(last_event_id) + 1 if last_event_id is not None else 0
    except ValueError:
        start = 0

    async def stream() -> AsyncIterator[str]:
        # Snapshot the backlog and subscribe with no await in between: the log
        # is only mutated on this loop, so no event can fall into a gap.
        backlog = list(enumerate(state.events))[start:]
        q: asyncio.Queue = asyncio.Queue()
        if not state.done:
            state.subscribers.add(q)
        try:
            for seq, e in backlog:
                yield _frame(seq, e)
            if state.done:
                return
            while True:
                try:
                    seq, e = await asyncio.wait_for(q.get(), HEARTBEAT_S)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield _frame(seq, e)
                if e["event"] == "stream_end":
                    return
        finally:
            state.subscribers.discard(q)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers=SSE_HEADERS
    )
