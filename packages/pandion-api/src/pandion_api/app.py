"""create_app: a FastAPI app over Pandion's public API, with a site's Policy."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from pandion_api.documents import DocumentStore
from pandion_api.policy import Policy
from pandion_api.routes import ask, documents, evaluations, health, projects, questions, results, sort, strategies
from pandion_api.routes import runs as run_routes
from pandion_api.routes import settings as settings_routes
from pandion_api.runs import RunManager
from pandion_api.settings import ApiSettings

#: Every router, in the order docs/pandion-api/index.md lists them.
ROUTERS = (
    health.router, strategies.router, documents.router, questions.router, run_routes.router, sort.router, ask.router,
    evaluations.router, results.router, settings_routes.router, projects.router,
)


def create_app(
    settings: ApiSettings,
    policy: Policy | None = None,
    *,
    mode: str = "lab",
    pipeline: str | Path | None = None,
    conversations: Any = None,
    serve: Any = None,
) -> FastAPI:
    """The app. `policy` holds the site's rules; the default allows everything.

    `mode="lab"` (the default) takes a pipeline with each request. `mode="serve"`
    loads the one pipeline file at `pipeline` and answers POST /chat; it keeps
    conversations in `conversations` (a Pandion conversation store, else SQL in
    the data folder) and takes its chat settings from `serve` (`ServeSettings`).
    See docs/pandion-api/serve-mode.md, "Serve mode"."""
    if mode == "serve":
        from pandion_api.serve import create_serve_app

        return create_serve_app(settings, policy, pipeline, conversations, serve)
    if mode != "lab":
        raise ValueError(f"mode must be 'lab' or 'serve', not '{mode}'.")
    policy = policy or Policy()
    manager = RunManager(limit=policy.max_active_runs)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await policy.on_startup(app)
        try:
            yield
        finally:
            await manager.shutdown()
            await policy.on_shutdown(app)

    app = FastAPI(title=settings.title, lifespan=lifespan)
    app.state.settings = settings
    app.state.policy = policy
    app.state.runs = manager
    app.state.documents = DocumentStore(settings.sources)
    for router in ROUTERS:
        app.include_router(router, prefix=settings.prefix, dependencies=policy.dependencies())
    return app
