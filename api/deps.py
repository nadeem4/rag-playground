"""Process-wide dependencies: the registry, the store, and where files live.

`plugins.discover()` runs exactly once, at import. The directories default to
`artifacts/` and `sources/` at the repo root and can be moved with
`RAG_PLAYGROUND_ARTIFACTS` / `RAG_PLAYGROUND_SOURCES`; tests pass temp dirs to
`build_deps` directly. The embedding cache sits in `.embcache` under the
artifacts folder, so clearing the cache clears it too, unless
`RAG_PLAYGROUND_EMBED_CACHE` names another folder.

The package takes every folder as an argument, so a run gets them through
`Deps.run_extras()`, which the run routes pass as `context_extras`.

**The sources folder reaches a run as `Sources(sources_dir)`.** The upload
step resolves `<sha><suffix>` in it, so the API stores uploads there under the
same name (`pandion.sources.Sources`), or every run fails with
FileNotFoundError.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pandion.embedding_cache import EmbeddingCache
from pandion.models import ModelSettings
from pandion.registry import Registry
from pandion.registry import registry as global_registry
from pandion.storage import Store
from pandion.sources import Sources
from plugins import discover, hosted_demo

REPO_ROOT = Path(__file__).resolve().parents[1]

discover()

#: How the app loads local models: on the CPU, from the Hugging Face folder.
APP_MODELS = ModelSettings(device="cpu")


@dataclass
class Deps:
    registry: Registry
    store: Store
    sources_dir: Path
    web_dist: Path
    embedding_cache: EmbeddingCache

    def run_extras(self) -> dict[str, Any]:
        """What every run is handed besides credentials. Never hashed or stored.

        Models load on the CPU, as they always have here, and download into
        the Hugging Face folder (`HF_HOME`) on first use. On the hosted demo a
        step that calls a custom endpoint accepts only a public https address
        (`pandion.endpoints`). The switch is read per run from
        `plugins.hosted_demo`, apart from `api.demo`, which the run routes'
        403 reads, so this second line holds even if the first is lifted.
        """
        return {
            "sources": Sources(self.sources_dir),
            "embedding_cache": self.embedding_cache,
            "models": APP_MODELS,
            "public_endpoints_only": hosted_demo.enabled(),
        }


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
    return Deps(
        registry=registry or global_registry,
        store=Store(artifacts_dir),
        sources_dir=sources_dir,
        web_dist=Path(web_dist or REPO_ROOT / "web" / "dist"),
        embedding_cache=EmbeddingCache(
            os.environ.get("RAG_PLAYGROUND_EMBED_CACHE") or artifacts_dir / ".embcache"
        ),
    )
