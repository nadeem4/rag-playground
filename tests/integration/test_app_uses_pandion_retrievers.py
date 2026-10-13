"""The app retrieves with the pandion package, not with a copy of its own.

The `dense`, `bm25` and `hybrid_rrf` retrievers moved into pandion. These
tests prove the app runs on them: the app's registry holds the package's
classes, the old module is gone, and a graph run the way the API runs it (the
executor, the app's registry and store, `Deps.run_extras`) returns the same
hits, in the same order with the same scores, as the same graph run with only
the package: its executor, its own store, sources, embedding cache and model
settings. The fake embedder keeps it offline.
"""

from __future__ import annotations

import importlib.util

import pytest

from api.deps import build_deps
from pandion.artifacts import ArtifactType
from pandion.embedding_cache import EmbeddingCache
from pandion.executor import NodeStatus, run
from pandion.graph import Edge, Graph, Node
from pandion.models import ModelSettings
from pandion.payloads import RetrievalResult
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry
from pandion.sources import Sources
from pandion.storage import Store
from tests.steps.conftest import SAMPLE_PAGES, build_pdf

RETRIEVERS = ["dense", "bm25", "hybrid_rrf"]
QUESTION = "What is the capital of France?"


@pytest.mark.parametrize("name", RETRIEVERS)
def test_the_app_registry_holds_the_package_retriever(name):
    assert registry.get(Stage.RETRIEVE, name).__module__ == f"pandion.plugins.retrieve.{name}"


def test_the_app_has_no_retriever_of_its_own():
    modules = {cls.__module__ for cls in registry.all_for(Stage.RETRIEVE).values()}
    assert modules and all(m.startswith("pandion.") for m in modules)


@pytest.mark.parametrize(
    "module", ["plugins.retrieve", "plugins.retrieve._base", "plugins.retrieve.dense"]
)
def test_the_old_module_is_gone(module):
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


def graph(sha: str, filename: str) -> Graph:
    """pdfium -> chunk -> lancedb -> each retriever, all asking one question."""
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": filename}),
        Node("q", Stage.QUERY, "text", {"text": QUESTION}),
        Node("parse", Stage.PARSE, "pdfium", {}),
        Node("chunk", Stage.CHUNK, "recursive_character", {"chunk_size": 70, "chunk_overlap": 10}),
        Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
    ]
    nodes += [Node(name, Stage.RETRIEVE, name, {"top_k": 5}) for name in RETRIEVERS]
    edges = [
        Edge("src", "parse", "file"),
        Edge("parse", "chunk", "doc"),
        Edge("chunk", "index", "chunks"),
    ]
    edges += [Edge("index", name, "index") for name in RETRIEVERS]
    return Graph(nodes=nodes, edges=edges)


def hits(result, store: Store, name: str) -> list[tuple[str, int, float, dict]]:
    node = result.nodes[name]
    assert node.status is NodeStatus.EXECUTED, node.error
    found = RetrievalResult.model_validate(store.load(node.artifact.id, ArtifactType.RETRIEVAL_RESULT))
    return [(h.matched_chunk_id, h.rank, h.score, h.component_scores) for h in found.hits]


def test_the_app_run_returns_the_same_hits_as_the_package(tmp_path):
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))

    deps = build_deps(
        artifacts_dir=tmp_path / "artifacts",
        sources_dir=tmp_path / "sources",
        web_dist=tmp_path / "web",
    )
    stored = deps.run_extras()["sources"].add(pdf)
    in_app = run(
        graph(stored.sha, stored.filename), deps.registry, deps.store,
        context_extras=deps.run_extras(),
    )

    discover()
    sources = Sources(tmp_path / "pandion-sources")
    store = Store(tmp_path / "pandion-store")
    kept = sources.add(pdf)
    in_package = run(
        graph(kept.sha, kept.filename), registry, store,
        context_extras={
            "sources": sources,
            "embedding_cache": EmbeddingCache(tmp_path / "pandion-cache"),
            "models": ModelSettings(),
        },
    )

    assert in_app.ok and in_package.ok
    for name in RETRIEVERS:
        assert in_app.nodes[name].artifact.id == in_package.nodes[name].artifact.id
        app_hits = hits(in_app, deps.store, name)
        assert app_hits
        assert app_hits == hits(in_package, store, name)
