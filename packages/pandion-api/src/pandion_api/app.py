"""create_app: a FastAPI app over Pandion's public API, with a site's Policy."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from pandion_api.documents import DocumentStore
from pandion_api.policy import Policy
from pandion_api.routes import ask, documents, health, questions, results, strategies
from pandion_api.routes import runs as run_routes
from pandion_api.runs import RunManager
from pandion_api.settings import ApiSettings

#: Every router, in the order docs/pandion-api.md lists them.
ROUTERS = (health.router, strategies.router, documents.router, questions.router, run_routes.router, ask.router, results.router)


def create_app(settings: ApiSettings, policy: Policy | None = None) -> FastAPI:
    """The app. `policy` holds the site's rules; the default allows everything."""
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
