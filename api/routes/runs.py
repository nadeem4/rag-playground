"""Runs and sweeps: create by POST, stream by GET (EventSource is GET-only).

Requests are validated *before* a run is created: an invalid graph is a 400 and
an invalid node config a 422, rather than a run that dies in its worker thread.

Every provider's key (Anthropic, OpenAI, custom endpoint, OpenRouter) is resolved once per
request (`api.credentials`) and handed to the executor as `context_extras`. The
keys live only in the job's closure for the run's duration, never on
`RunState`, and every event the run emits is passed through `redact`, so a
transform that puts a key in an exception message cannot surface it in
`node_failed`.

In demo mode a chat node set to the `custom` model is refused with a 403: it
would make the server send a request to a URL a visitor chose. In every mode
a node's `max_tokens` or text budget above the playground's caps is a 403, with
the function /api/v2 uses (`api.policy.step_over_limit`).
"""

from __future__ import annotations

import json
import traceback
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError

from api import demo
from api.credentials import redact, resolve_all
from api.routes.registry import read_only_settings
from pandion_api.runs import RunState, cancel_response, events_response, start_at
from pandion.executor import run, sweep
from pandion.extend import Stage
from pandion.graph import Edge, Graph, GraphValidationError, Node
from pandion.registry import Registry, UnknownTransformError

router = APIRouter()

PROMPTS_FIXED = "The prompts and the model revision are fixed in the playground. Set them in a pipeline file or in code."

DEMO_NO_CUSTOM = (
    "custom endpoints are disabled in this hosted demo: the server would send "
    "a request to a URL a visitor chose. Run the playground locally to use one."
)

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
    variants: list[VariantIn] = Field(min_length=1, max_length=10)
    through: str | None = None
    force: bool = False


def _check(
    graph: Graph, registry: Registry, request: Request, overrides: dict | None = None
) -> None:
    """Raise the HTTP error a run would otherwise hit in its worker thread."""
    overrides = overrides or {}
    if demo.enabled():
        for nd in graph.nodes:
            cfg = overrides.get(nd.id, nd.config)
            if _is_custom_endpoint(nd.stage, nd.transform, cfg):
                raise HTTPException(status_code=403, detail=DEMO_NO_CUSTOM)
    for nd in graph.nodes:
        if _changes_a_read_only_setting(registry, nd, overrides.get(nd.id, nd.config)):
            raise HTTPException(status_code=403, detail=PROMPTS_FIXED)
    # The playground's caps on model output and text budgets, as on /api/v2.
    # Imported here: api.policy imports this module for its messages.
    from api.policy import step_over_limit

    for nd in graph.nodes:
        refusal = step_over_limit(nd.id, nd.stage.value, nd.transform, overrides.get(nd.id, nd.config))
        if refusal:
            raise HTTPException(status_code=403, detail=refusal)
    try:
        graph.validate(registry)
    except GraphValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for nd in graph.nodes:
        cfg = overrides.get(nd.id, nd.config)
        if nd.stage == Stage.SOURCE and cfg.get("sha") and not demo.readable(cfg["sha"], request):
            raise HTTPException(
                status_code=403,
                detail=(
                    "This document is not available to this browser. It may be an upload that has "
                    "expired, or one made from another browser. Load a sample or upload the file again."
                ),
            )
        cls = registry.get(nd.stage, nd.transform)
        try:
            cls.config_model(**cfg)
        except ValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"node_id": nd.id, "errors": json.loads(exc.json())},
            ) from exc


#: Transforms that call a chat model, and so could call a visitor's custom endpoint.
_MODEL_CALLERS = {
    (Stage.USE_CASE, "chat"),
    (Stage.RERANK, "llm_rerank"),
    (Stage.QUERY, "llm_rewrite"),
}


def _changes_a_read_only_setting(registry: Registry, nd: Node, cfg: dict[str, Any]) -> bool:
    """Whether `cfg` sets a readOnly setting (a prompt, a model revision) to anything but its default.

    In every mode: the app has no control that sets a prompt, so a changed one
    can only come from a crafted request, a share link or an imported pipeline,
    and it would then run with another visitor's key."""
    try:
        model = registry.get(nd.stage, nd.transform).config_model
    except UnknownTransformError:
        return False  # graph.validate reports it
    fields = model.model_fields
    props = model.model_json_schema().get("properties", {})
    return any(
        key in cfg and cfg[key] != fields[key].default for key in read_only_settings(props)
    )


def _is_custom_endpoint(stage: Stage, transform: str, cfg: dict[str, Any]) -> bool:
    return (stage, transform) in _MODEL_CALLERS and cfg.get("model") == "custom"


def _credentials(
    anthropic: str | None,
    openai: str | None,
    custom: str | None,
    openrouter: str | None = None,
) -> tuple[list[str], dict[str, Any] | None]:
    """(keys, context_extras). No key resolved means no credentials entry."""
    creds = resolve_all(
        {"anthropic": anthropic, "openai": openai, "custom": custom, "openrouter": openrouter}
    )
    if not creds:
        return [], None
    return list(creds.values()), {"credentials": creds}


def _guarded(keys: list[str], fn):
    """Run `fn`, re-raising any crash with the keys scrubbed from its traceback."""
    try:
        return fn()
    except Exception:
        if not keys:
            raise
        raise RuntimeError(redact(traceback.format_exc(), keys)) from None


def _unknown(graph: Graph, ids: list[str], what: str) -> None:
    known = {nd.id for nd in graph.nodes}
    missing = [i for i in ids if i not in known]
    if missing:
        raise HTTPException(status_code=400, detail=f"unknown {what}: {missing}")


@router.post("/runs", status_code=202)
async def create_run(
    body: RunIn,
    request: Request,
    x_anthropic_api_key: str | None = Header(default=None),
    x_openai_api_key: str | None = Header(default=None),
    x_custom_api_key: str | None = Header(default=None),
    x_openrouter_api_key: str | None = Header(default=None),
) -> dict[str, str]:
    deps = request.app.state.deps
    graph = body.graph.to_graph()
    _check(graph, deps.registry, request, body.overrides)
    _unknown(graph, body.targets or [], "target")
    keys, extras = _credentials(
        x_anthropic_api_key, x_openai_api_key, x_custom_api_key, x_openrouter_api_key
    )

    def job(emit, cancel):
        seen: list[bool] = []

        def on_event(e):
            if e["event"] == "run_cancelled":
                seen.append(True)
            emit(redact(e, keys))

        res = _guarded(
            keys,
            lambda: run(
                graph,
                deps.registry,
                deps.store,
                overrides=body.overrides,
                targets=set(body.targets) if body.targets else None,
                force=body.force,
                on_event=on_event,
                cancelled=cancel.is_set,
                context_extras={**deps.run_extras(), **(extras or {})},
            ),
        )
        return res.ok, bool(seen)

    state = request.app.state.runs.start("run", job)
    return {"run_id": state.run_id}


@router.post("/sweeps", status_code=202)
async def create_sweep(
    body: SweepIn,
    request: Request,
    x_anthropic_api_key: str | None = Header(default=None),
    x_openai_api_key: str | None = Header(default=None),
    x_custom_api_key: str | None = Header(default=None),
    x_openrouter_api_key: str | None = Header(default=None),
) -> dict[str, str]:
    """Start a sweep: one node of the graph run over each recipe in turn.

    A sweep takes at most ten recipes, which bounds the work one request can ask of the hosted demo.
    """
    deps = request.app.state.deps
    graph = body.graph.to_graph()
    _unknown(graph, [body.node_id] + ([body.through] if body.through else []), "node")
    target = graph.node(body.node_id)
    if demo.enabled() and any(
        _is_custom_endpoint(target.stage, v.transform, v.config) for v in body.variants
    ):
        raise HTTPException(status_code=403, detail=DEMO_NO_CUSTOM)
    if any(
        _changes_a_read_only_setting(
            deps.registry, Node(target.id, target.stage, v.transform, v.config), v.config
        )
        for v in body.variants
    ):
        raise HTTPException(status_code=403, detail=PROMPTS_FIXED)
    from api.policy import step_over_limit  # api.policy imports this module

    for v in body.variants:
        refusal = step_over_limit(target.id, target.stage.value, v.transform, v.config)
        if refusal:
            raise HTTPException(status_code=403, detail=refusal)
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
        _check(variant_graph, deps.registry, request)
    variants = [{"transform": v.transform, "config": v.config} for v in body.variants]
    keys, extras = _credentials(
        x_anthropic_api_key, x_openai_api_key, x_custom_api_key, x_openrouter_api_key
    )

    def job(emit, cancel):
        seen: list[bool] = []

        def on_event(e):
            if e["event"] == "run_cancelled":
                seen.append(True)
            emit(redact(e, keys))

        res = _guarded(
            keys,
            lambda: sweep(
                graph,
                deps.registry,
                deps.store,
                node_id=body.node_id,
                variants=variants,
                through=body.through,
                force=body.force,
                on_event=on_event,
                cancelled=cancel.is_set,
                context_extras={**deps.run_extras(), **(extras or {})},
            ),
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
    return cancel_response(request.app.state.runs, _state(request, run_id))


@router.get("/runs/{run_id}/events")
async def run_events(
    run_id: str,
    request: Request,
    last_event_id: str | None = Header(default=None),
    resume_after: str | None = Query(default=None, alias="last_event_id"),
):
    """Replay from after `Last-Event-ID`, else from the log start.

    `?last_event_id=N` means the same as the header. `EventSource` cannot set
    that header on a connection it did not open itself, so a client doing its
    own reconnect passes the query parameter instead. The header wins when both
    are sent: it comes from the browser's own, more recent, auto-reconnect.
    """
    return events_response(_state(request, run_id), start_at(last_event_id, resume_after))
