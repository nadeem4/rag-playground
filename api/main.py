"""The FastAPI app: pandion-api with the playground's Policy, the old /api routes
and the teaching routes, and the web build. `create_app(deps)` for tests;
`api.main:app` for uvicorn.

pandion-api's routes sit under /api/v2. The old routes stay under /api with
their shapes until part 5 moves the web onto /api/v2. Both share one run
manager, so the demo's limit on runs at once holds across them.

`app` is built lazily on first access, so importing this module (as the tests
do) does not build the default dependencies and their folders.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from pandion_api import ApiSettings
from pandion_api import create_app as create_api

from api.deps import APP_MODELS, Deps, build_deps
from api.policy import PlaygroundPolicy
from api.routes import (
    artifacts,
    health,
    learn,
    pages,
    questions,
    registry,
    runs,
    samples,
    settings,
    sources,
    trace,
)
from api.static import mount_spa

#: Where pandion-api's routes sit, beside the old /api routes.
API_PREFIX = "/api/v2"


def api_settings(deps: Deps) -> ApiSettings:
    """pandion-api runs every pipeline under one folder, so the sources and
    artifacts folders must be `<folder>/sources` and `<folder>/artifacts`."""
    data_dir = deps.sources_dir.parent
    if (
        deps.sources_dir.name != "sources"
        or deps.store.root.resolve() != (data_dir / "artifacts").resolve()
    ):
        raise ValueError(
            f"The sources folder ({deps.sources_dir}) and the artifacts folder "
            f"({deps.store.root}) must sit side by side in one folder, named sources "
            "and artifacts, because every pipeline runs under one path. Set "
            "RAG_PLAYGROUND_SOURCES to <folder>/sources and RAG_PLAYGROUND_ARTIFACTS "
            "to <folder>/artifacts."
        )
    return ApiSettings(data_dir=data_dir, models=APP_MODELS, prefix=API_PREFIX, title="RAG Playground")


def create_app(deps: Deps | None = None) -> FastAPI:
    deps = deps or build_deps()
    app = create_api(api_settings(deps), PlaygroundPolicy())
    app.state.deps = deps
    for r in (
        health.router,
        registry.router,
        sources.router,
        pages.router,
        runs.router,
        artifacts.router,
        settings.router,
        learn.router,
        samples.router,
        questions.router,
        trace.router,
    ):
        app.include_router(r, prefix="/api")
    mount_spa(app, deps.web_dist)  # last: the catch-all route
    return app


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
