"""The FastAPI app: pandion-api with the playground's Policy, the teaching
routes, and the web build. `create_app(deps)` for tests; `playground.backend.main:app` for
uvicorn.

pandion-api's routes sit under /api/v2: every run, document, result and key
check goes through them. The playground's own routes under /api are only the
teaching routes: health, the samples, the lessons, the stage explanations, the
app settings and the question template.

`app` is built lazily on first access, so importing this module (as the tests
do) does not build the default dependencies and their folders.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from pandion_api import ApiSettings
from pandion_api import create_app as create_api

from playground.backend.deps import APP_MODELS, Deps, build_deps
from playground.backend.policy import PlaygroundPolicy
from playground.backend.routes import health, learn, questions, registry, samples, settings, sources
from playground.backend.static import mount_spa

#: Where pandion-api's routes sit, beside the teaching routes under /api.
API_PREFIX = "/api/v2"


def api_settings(deps: Deps) -> ApiSettings:
    """pandion-api runs every pipeline under one folder, so the sources and
    artifacts folders must be `<folder>/sources` and `<folder>/artifacts`."""
    data_dir = deps.sources_dir.parent
    if (
        deps.sources_dir.name != "sources"
        or deps.artifacts_dir.resolve() != (data_dir / "artifacts").resolve()
    ):
        raise ValueError(
            f"The sources folder ({deps.sources_dir}) and the artifacts folder "
            f"({deps.artifacts_dir}) must sit side by side in one folder, named sources "
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
        settings.router,
        learn.router,
        samples.router,
        questions.router,
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
