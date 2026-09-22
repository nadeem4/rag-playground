"""The FastAPI app. `create_app(deps)` for tests; `api.main:app` for uvicorn.

`app` is built lazily on first access, so importing this module (as the tests
do) does not rebind `upload.SOURCES_DIR` to the default directory.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from api.deps import Deps, build_deps
from api.routes import artifacts, learn, pages, registry, runs, settings, sources
from api.runs import RunManager
from api.static import mount_spa


def create_app(deps: Deps | None = None) -> FastAPI:
    manager = RunManager()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await manager.shutdown()

    app = FastAPI(title="RAG Playground", lifespan=lifespan)
    app.state.deps = deps or build_deps()
    app.state.runs = manager
    for r in (
        registry.router,
        sources.router,
        pages.router,
        runs.router,
        artifacts.router,
        settings.router,
        learn.router,
    ):
        app.include_router(r, prefix="/api")
    mount_spa(app, app.state.deps.web_dist)  # last: the catch-all route
    return app


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
