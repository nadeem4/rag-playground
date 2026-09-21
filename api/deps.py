"""Process-wide dependencies: the registry, the store, and where files live.

`plugins.discover()` runs exactly once, at import. The directories default to
`artifacts/` and `sources/` at the repo root and can be moved with
`RAG_PLAYGROUND_ARTIFACTS` / `RAG_PLAYGROUND_SOURCES`; tests pass temp dirs to
`build_deps` directly.

**`plugins.source.upload.SOURCES_DIR` is rebound here.** The upload transform
resolves `SOURCES_DIR / f"{sha}{Path(filename).suffix}"`, so the API must write
uploads into that same directory under that same name, or every run fails with
FileNotFoundError.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from core.registry import Registry
from core.registry import registry as global_registry
from core.storage import Store
from plugins import discover
from plugins.source import upload

REPO_ROOT = Path(__file__).resolve().parents[1]

discover()


@dataclass
class Deps:
    registry: Registry
    store: Store
    sources_dir: Path
    web_dist: Path


def build_deps(
    *,
    artifacts_dir: Path | None = None,
    sources_dir: Path | None = None,
    web_dist: Path | None = None,
    registry: Registry | None = None,
) -> Deps:
    artifacts_dir = Path(
        artifacts_dir
        or os.environ.get("RAG_PLAYGROUND_ARTIFACTS")
        or REPO_ROOT / "artifacts"
    )
    sources_dir = Path(
        sources_dir or os.environ.get("RAG_PLAYGROUND_SOURCES") or REPO_ROOT / "sources"
    )
    upload.SOURCES_DIR = sources_dir
    return Deps(
        registry=registry or global_registry,
        store=Store(artifacts_dir),
        sources_dir=sources_dir,
        web_dist=Path(web_dist or REPO_ROOT / "web" / "dist"),
    )
