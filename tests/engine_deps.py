"""What the app's old run routes handed the engine, for tests that run a graph.

The app no longer runs a graph itself: every run goes through pandion-api. A
few tests still run the engine's executor on a graph, to check it agrees with
Pandion's public API or to reach a step the way a run does. `engine_deps`
gives them the registry, a store and the run extras the old `api.deps.Deps`
gave, with the embedding cache inside the artifacts folder.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from api import demo
from api.deps import APP_MODELS
from pandion.embedding_cache import EmbeddingCache
from pandion.registry import Registry, registry
from pandion.sources import Sources
from pandion.storage import Store


@dataclass
class EngineDeps:
    registry: Registry
    store: Store
    sources_dir: Path
    embedding_cache: EmbeddingCache

    def run_extras(self) -> dict[str, Any]:
        """The folders, the models and the demo's endpoint switch, as a run is handed them."""
        return {
            "sources": Sources(self.sources_dir),
            "embedding_cache": self.embedding_cache,
            "models": APP_MODELS,
            "public_endpoints_only": demo.public_endpoints_only(),
        }


def engine_deps(*, artifacts_dir: Path, sources_dir: Path | None = None) -> EngineDeps:
    artifacts_dir = Path(artifacts_dir)
    return EngineDeps(
        registry=registry,
        store=Store(artifacts_dir),
        sources_dir=Path(sources_dir or artifacts_dir.parent / "sources"),
        embedding_cache=EmbeddingCache(artifacts_dir / ".embcache"),
    )
