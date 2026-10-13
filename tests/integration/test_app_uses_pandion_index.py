"""The app indexes with the pandion package, not with a copy of its own.

The embedders, the embedding cache, the lancedb index and the upload step
moved into pandion. These tests prove the app runs on them: the app's registry
holds the package's classes, the old modules are gone, and a graph run the way
the API runs it (the executor, the app's registry and store, `Deps.run_extras`)
stores the same index, with the same ids and vectors, as the package's
`Pipeline` on the same file with the same settings.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import lancedb
import pytest

from api.deps import build_deps
from pandion import Pipeline
from pandion.artifacts import ArtifactType
from pandion.executor import run
from pandion.graph import Edge, Graph, Node
from pandion.ports import Stage
from pandion.registry import registry
from tests.steps.conftest import SAMPLE_PAGES, build_pdf

CHUNK = {"chunk_size": 70, "chunk_overlap": 10}

CONFIG = """\
path: ./pandion-index
index:
  parse:
    use: pdfium
  chunk:
    use: recursive_character
    chunk_size: 70
    chunk_overlap: 10
  embed:
    use: fake-deterministic
  store:
    use: lancedb
"""


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


def rows(index_dir: Path) -> list[dict]:
    table = lancedb.connect(index_dir).open_table("chunks")
    return sorted(table.to_arrow().to_pylist(), key=lambda r: r["id"])


def test_the_app_run_stores_the_same_index_as_the_pipeline(tmp_path):
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    deps = build_deps(
        artifacts_dir=tmp_path / "artifacts",
        sources_dir=tmp_path / "sources",
        web_dist=tmp_path / "web",
    )
    stored = deps.run_extras()["sources"].add(pdf)
    graph = Graph(
        nodes=[
            Node("src", Stage.SOURCE, "upload", {"sha": stored.sha, "filename": stored.filename}),
            Node("parse", Stage.PARSE, "pdfium", {}),
            Node("chunk", Stage.CHUNK, "recursive_character", CHUNK),
            Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
        ],
        edges=[
            Edge("src", "parse", "file"),
            Edge("parse", "chunk", "doc"),
            Edge("chunk", "index", "chunks"),
        ],
    )

    in_app = run(graph, deps.registry, deps.store, context_extras=deps.run_extras())

    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG, encoding="utf-8")
    report = Pipeline.from_file(config).index.run(pdf)

    assert in_app.ok and report.ok
    stages = report.documents["sample.pdf"].stages
    assert stages["chunk"].artifact_id == in_app.nodes["chunk"].artifact.id
    assert report.index.artifact_id == in_app.nodes["index"].artifact.id
    app_rows = rows(deps.store.load(in_app.nodes["index"].artifact.id, ArtifactType.INDEX))
    pipeline_rows = rows(report.index.output)
    assert len(app_rows) > 1
    assert [r["id"] for r in app_rows] == [r["id"] for r in pipeline_rows]
    assert [r["vector"] for r in app_rows] == [r["vector"] for r in pipeline_rows]
