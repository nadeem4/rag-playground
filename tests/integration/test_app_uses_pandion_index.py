"""The app indexes with the pandion package, not with a copy of its own.

The embedders, the embedding cache, the lancedb index and the upload step moved
into pandion. These tests prove the app runs on them: the registry holds the
package's classes, the old modules are gone, and the warm-up loads Docling and
Qwen3 through Pandion's public preloads with the app's model settings.
"""

from __future__ import annotations

import importlib.util

import pytest

from pandion.ports import Stage
from pandion.registry import registry

def test_the_app_registry_holds_the_package_index_and_upload():
    assert registry.get(Stage.INDEX, "lancedb").__module__ == "pandion.plugins.index.lancedb_store"
    assert registry.get(Stage.SOURCE, "upload").__module__ == "pandion.plugins.source.upload"


@pytest.mark.parametrize(
    "module",
    [
        "plugins.index.lancedb_store",
        "plugins.source.upload",
        "providers.embeddings",
        "providers.embedding_cache",
    ],
)
def test_the_old_module_is_gone(module):
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


def test_the_warm_up_loads_docling_and_qwen3_through_the_public_preloads(monkeypatch):
    import pandion
    from api import warmup
    from api.deps import APP_MODELS

    loaded: list = []
    monkeypatch.setattr(pandion, "preload_parser", lambda use="docling": loaded.append(("parser", use)))
    monkeypatch.setattr(pandion, "preload_embedder", lambda name, settings=None: loaded.append((name, settings)))
    warmup._warm_index_models()
    assert loaded == [("parser", "docling"), ("qwen3-embedding-0.6b", APP_MODELS)]
