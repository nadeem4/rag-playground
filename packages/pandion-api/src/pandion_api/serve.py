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
from fastapi import FastAPI

from pandion import Pipeline
from pandion.extend import ALL_ROLES
from pandion.extend import ChatSettings
from pandion.extend import ConversationStore, get_conversation_store
from pandion_api.observability import TraceIdMiddleware, configure_logging, setup_tracing
from pandion_api.policy import Policy
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
    long a conversation is kept without a new turn."""

    chat: ChatSettings = field(default_factory=ChatSettings)
    retention_days: int = 90

    def __post_init__(self) -> None:
        if self.retention_days < 1:
            raise ValueError("retention_days must be at least 1.")


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
    of its own `path` and `models`, as lab mode does for a request. A file that
    cannot be read or is refused stops startup with a one-sentence ValueError."""
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        raise ValueError(f"The pipeline file {path} could not be read as YAML.") from None
    if not isinstance(data, dict):
        raise ValueError(f"The pipeline file {path} must be a mapping of settings.")
    models = settings.models.model_dump(mode="json")
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
    policy = policy or Policy()
    loaded = load_pipeline(pipeline, settings)
    manager = RunManager(limit=policy.max_active_runs)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await policy.on_startup(app)
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
            await policy.on_shutdown(app)

    app = FastAPI(title=settings.title, lifespan=lifespan)
    state: Any = app.state
    state.settings, state.policy, state.runs = settings, policy, manager
    state.serve = serve or ServeSettings()
    state.background = set()
    state.tracer = setup_tracing()  # None unless OTEL_EXPORTER_OTLP_ENDPOINT is set
    state.pipeline = loaded
    state.conversations = conversations if conversations is not None else default_store(settings)
    app.add_middleware(TraceIdMiddleware)
    for router in SERVE_ROUTERS:
        app.include_router(router, prefix=settings.prefix, dependencies=policy.dependencies())
    return app
