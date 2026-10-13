"""The app chunks with the pandion package, not with a copy of its own.

The chunkers moved into `pandion.plugins.chunk`. These tests prove the app
runs on them: every chunker the app's registry holds is the package's class,
the old `plugins.chunk` module is gone, and a graph run the way the API runs it
(the executor, the app's registry and a store) gives the same pieces as
`pandion.chunk` on the same document with the same settings.
"""

from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

import pytest

import pandion
from pandion.artifacts import ArtifactType
from pandion.executor import NodeStatus, run
from pandion.graph import Edge, Graph, Node
from pandion.payloads import ChunkSet
from pandion.ports import Stage
from pandion.registry import registry
from pandion.sources import Sources
from pandion.storage import Store
from tests.plugins.conftest import SAMPLE_PAGES, build_pdf

#: Every chunker, with settings small enough that the sample PDF becomes
#: several pieces rather than one.
CHUNKERS = {
    "recursive_character": {"chunk_size": 70, "chunk_overlap": 10},
    "layout_blocks": {"max_tokens": 16},
    "markdown_header": {"max_tokens": 16},
    "token_based": {"max_tokens": 12, "overlap": 2},
    "sentence_window": {"sentences_per_chunk": 2, "overlap_sentences": 1},
}


@pytest.mark.parametrize("name", sorted(CHUNKERS))
def test_the_app_registry_holds_the_package_chunker(name):
    cls = registry.get(Stage.CHUNK, name)

    assert cls.__module__ == f"pandion.plugins.chunk.{name}"


def test_the_app_registry_has_no_chunker_of_its_own():
    modules = {cls.__module__ for cls in registry.all_for(Stage.CHUNK).values()}

    assert modules and all(m.startswith("pandion.") for m in modules)
    assert set(registry.all_for(Stage.CHUNK)) == set(CHUNKERS)


def test_the_old_chunk_module_is_gone():
    try:
        spec = importlib.util.find_spec("plugins.chunk")
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


@pytest.fixture
def pdf(tmp_path: Path) -> tuple[Path, str]:
    """The sample PDF on disk, and stored in a relocated `sources/` for the app."""
    data = build_pdf(SAMPLE_PAGES)
    sha = hashlib.sha256(data).hexdigest()
    sources = tmp_path / "sources"
    sources.mkdir()
    (sources / f"{sha}.pdf").write_bytes(data)
    path = tmp_path / "sample.pdf"
    path.write_bytes(data)
    return path, sha


@pytest.mark.parametrize("name", sorted(CHUNKERS))
def test_the_app_run_gives_the_same_pieces_as_pandion_chunk(name, pdf, tmp_path):
    path, sha = pdf
    settings = CHUNKERS[name]
    graph = Graph(
        nodes=[
            Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": path.name}),
            Node("parse", Stage.PARSE, "pdfium", {}),
            Node("chunk", Stage.CHUNK, name, settings),
        ],
        edges=[Edge("src", "parse", "file"), Edge("parse", "chunk", "doc")],
    )
    store = Store(tmp_path / "store")

    result = run(graph, registry, store, context_extras={"sources": Sources(tmp_path / "sources")})

    assert result.nodes["chunk"].status is NodeStatus.EXECUTED, result.nodes["chunk"].error
    in_app = ChunkSet.model_validate(
        store.load(result.nodes["chunk"].artifact.id, ArtifactType.CHUNK_SET)
    )
    on_its_own = pandion.chunk(pandion.parse(path, use="pdfium"), use=name, **settings).output

    assert len(in_app.chunks) > 1
    assert [c.text for c in in_app.chunks] == [c.text for c in on_its_own.chunks]
    assert [c.id for c in in_app.chunks] == [c.id for c in on_its_own.chunks]
    assert in_app.source_text == on_its_own.source_text
