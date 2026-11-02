"""Serve mode: one fixed pipeline, answering POST /chat for a site's users.

Lab mode lets a client send a pipeline with each request. Serve mode loads one
pipeline file once at startup and mounts only the routes in `SERVE_ROUTERS`,
so a lab route can never be mounted by mistake. See docs/pandion-api.md, "Serve mode".
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
import yaml
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from pandion import Pipeline
from pandion.extend import ALL_ROLES, EndpointRefused, guard_endpoint
from pandion.extend import ChatSettings
from pandion.extend import ConversationStore, get_conversation_store
from pandion_api.metrics import Metrics, start_server, stop_server
from pandion_api.errors import generic
from pandion_api.limits import BodyLimit, TurnLimiter
from pandion_api.observability import TraceIdMiddleware, configure_logging, setup_tracing
from pandion_api.policy import AnonymousPolicy, Policy
from pandion_api.routes import chat, conversations, serve_ask, serve_health
from pandion_api.runs import RunManager
from pandion_api.settings import ApiSettings

logger = logging.getLogger(__name__)

#: Every router serve mounts. Lab's `ROUTERS` is a different tuple.
SERVE_ROUTERS = (serve_health.router, chat.router, serve_ask.router, conversations.router)


#: Seconds between two retention sweeps.
DAY = 24 * 60 * 60


@dataclass(frozen=True)
class ServeSettings:
    """What serve mode is set up with, in code and not in the pipeline file.
    `chat` is how a turn rewrites, folds and remembers; `retention_days` is how
    long a conversation is kept without a new turn. `metrics_port` and `metrics_on_app`
    turn on the Prometheus metrics (extra `pandion-api[metrics]`)."""

    chat: ChatSettings = field(default_factory=ChatSettings)
    retention_days: int = 90
    #: The port Prometheus scrapes (9464 is the usual one); None turns metrics off.
    metrics_port: int | None = None
    #: Also serve GET /metrics on the API port, for a gateway that blocks a second port.
    metrics_on_app: bool = False
    #: Default limits for each user (see `pandion_api.limits`). In memory, per server copy.
    turns_per_minute: int = 20
    active_turns_per_user: int = 2
    max_body_bytes: int = 65536
    turn_deadline_s: float = 120.0
    #: Sites allowed to call the API from a browser. Empty: CORS is off. No "*".
    cors_origins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.retention_days < 1:
            raise ValueError("retention_days must be at least 1.")


NEEDS_POLICY = (
    "Serve mode needs a Policy that says who is asking. Subclass pandion_api.Policy and override "
    "user_id, roles and limit, or pass Policy.anonymous() on purpose."
)


def check_policy(policy: Policy | None, pipeline: Pipeline) -> Policy:
    """`policy` if serve may start with it, else a one-sentence ValueError."""
    if policy is None:
        raise ValueError(NEEDS_POLICY)
    missing = [name for name in ("user_id", "roles", "limit") if getattr(type(policy), name) is getattr(Policy, name)]
    if missing:
        raise ValueError(f"{NEEDS_POLICY} This policy does not override: {', '.join(missing)}.")
    if isinstance(policy, AnonymousPolicy) and pipeline.config.access is not None:
        raise ValueError(
            "The pipeline has an access block, but Policy.anonymous() gives every caller the same identity. "
            "Use a Policy that says who is asking, or remove the access block."
        )
    return policy


def check_public_endpoints(pipeline: Pipeline) -> None:
    """Stop startup when any step of the pipeline file names a custom endpoint that is not public."""

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "custom_base_url" and isinstance(item, str) and item.strip():
                    try:
                        guard_endpoint(item.strip(), public_only=True)
                    except EndpointRefused as exc:
                        raise ValueError(str(exc)) from None
                else:
                    walk(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item)

    walk(pipeline.to_dict())


async def retention_loop(store: ConversationStore, days: int, sleep=asyncio.sleep) -> None:
    """Delete conversations older than `days` now and every 24 hours, until cancelled.
    A sweep that fails is logged, and the next day tries again."""
    while True:
        try:
            removed = await asyncio.to_thread(store.expire, days)
            logger.info("retention sweep: removed %d conversations older than %d days", removed, days)
        except Exception as exc:  # noqa: BLE001  (a failed sweep must never stop the server)
            logger.warning("Retention sweep failed (%s); trying again in 24 hours.", type(exc).__name__)
        await sleep(DAY)


def load_pipeline(path: str | Path, settings: ApiSettings) -> Pipeline:
    """The pipeline file at `path`, with the server's folder and models in place
    of its own `path` and `models`, as lab mode does for a request, and with
    `public_endpoints_only` on. A file that cannot be read or is refused stops
    startup with a one-sentence ValueError."""
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        raise ValueError(f"The pipeline file {path} could not be read as YAML.") from None
    if not isinstance(data, dict):
        raise ValueError(f"The pipeline file {path} must be a mapping of settings.")
    models = {**settings.models.model_dump(mode="json"), "public_endpoints_only": True}
    return Pipeline.from_dict({**data, "path": str(settings.data_dir), "models": models}, base=settings.data_dir)


def default_store(settings: ApiSettings) -> ConversationStore:
    """The conversation store: SQL on `PANDION_CONVERSATIONS_URL`, else a SQLite file in the data folder.
    The store reads the url from the variable itself, so the server never holds it."""
    if os.environ.get("PANDION_CONVERSATIONS_URL"):
        return get_conversation_store("sql", {"url_env": "PANDION_CONVERSATIONS_URL"})
    Path(settings.data_dir).mkdir(parents=True, exist_ok=True)
    return get_conversation_store("sql", {"url": f"sqlite:///{(Path(settings.data_dir) / 'conversations.db').as_posix()}"})


def warm_up(p: Pipeline) -> None:
    """One throwaway search, so the first user does not wait for models to load.
    It is skipped when nothing is indexed, and a failure is logged and ignored."""
    try:
        if p.index.index_status().ready:
            p.retrieve("warm up", roles=ALL_ROLES)
    except Exception as exc:  # noqa: BLE001  (a warm-up must never stop the server)
        logger.warning("Warm-up skipped (%s).", type(exc).__name__)


def create_serve_app(
    settings: ApiSettings,
    policy: Policy | None = None,
    pipeline: str | Path | None = None,
    conversations: ConversationStore | None = None,
    serve: ServeSettings | None = None,
) -> FastAPI:
    """The serve app. `pipeline` is the pipeline file's path; `conversations`
    is a store, else `default_store`."""
    if pipeline is None:
        raise ValueError('Serve mode needs a pipeline file: pass pipeline="pipeline.yaml" to create_app.')
    configure_logging()
    loaded = load_pipeline(pipeline, settings)
    policy = check_policy(policy, loaded)
    check_public_endpoints(loaded)
    serve = serve or ServeSettings()
    if "*" in serve.cors_origins:
        raise ValueError("cors_origins must list the sites by name. A wildcard is not allowed in serve mode.")
    manager = RunManager(limit=policy.max_active_runs)
    metrics = Metrics() if serve.metrics_port is not None or serve.metrics_on_app else None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await policy.on_startup(app)
        port_server = start_server(metrics, serve.metrics_port) if metrics and serve.metrics_port is not None else None
        warming = asyncio.create_task(anyio.to_thread.run_sync(warm_up, loaded))
        retention = app.state.retention = asyncio.create_task(
            retention_loop(app.state.conversations, app.state.serve.retention_days))
        try:
            yield
        finally:
            retention.cancel()
            await asyncio.gather(retention, return_exceptions=True)
            await warming
            for thread in list(app.state.background):  # replies still saving a summary or a memory
                await anyio.to_thread.run_sync(thread.join)
            await manager.shutdown()
            if port_server:
                await anyio.to_thread.run_sync(stop_server, *port_server)
            await policy.on_shutdown(app)

    app = FastAPI(title=settings.title, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    state: Any = app.state
    state.settings, state.policy, state.runs = settings, policy, manager
    state.serve, state.metrics = serve, metrics
    state.limiter = TurnLimiter(serve.turns_per_minute, serve.active_turns_per_user)
    state.background = set()
    state.tracer = setup_tracing()  # None unless OTEL_EXPORTER_OTLP_ENDPOINT is set
    state.pipeline = loaded
    state.conversations = conversations if conversations is not None else default_store(settings)
    for router in SERVE_ROUTERS:
        app.include_router(router, prefix=settings.prefix, dependencies=policy.dependencies())

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        trace_id = request.state.trace_id
        logger.error("Unhandled error (%s).", type(exc).__name__, extra={"trace_id": trace_id})
        # This response leaves outside TraceIdMiddleware, so it carries the header itself.
        return JSONResponse(status_code=500, content={"detail": generic(trace_id)}, headers={"X-Trace-Id": trace_id})

    if serve.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=list(serve.cors_origins), allow_methods=["GET", "POST"], allow_headers=["*"])
    app.add_middleware(BodyLimit, max_bytes=serve.max_body_bytes)
    app.add_middleware(TraceIdMiddleware, metrics=metrics)  # outermost but the error handler: a 413 carries X-Trace-Id too
    return app
