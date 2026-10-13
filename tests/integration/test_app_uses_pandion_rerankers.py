"""The app reranks with the pandion package, not with a copy of its own.

The `mmr`, `cross_encoder` and `llm_rerank` steps moved into pandion. These
tests prove the app runs on them: the app's registry holds the package's
classes, the old module is gone, the warm-up loads the cross-encoder through
the public `preload_reranker` with the app's model settings, and a graph run
the way the API runs it (the executor, the app's registry and store,
`Deps.run_extras`) gives the same artifact ids and hits as `p.retrieve` with
the same settings on the same file. The fake embedder keeps it offline.
"""

from __future__ import annotations

import importlib.util
import logging
from types import SimpleNamespace

import pytest
import yaml

from api import warmup
from api.deps import APP_MODELS, build_deps
from pandion import Pipeline
from pandion.artifacts import ArtifactType
from pandion.executor import NodeStatus, run
from pandion.graph import Edge, Graph, Node
from pandion.payloads import RetrievalResult
from pandion.ports import Stage
from pandion.registry import registry
from tests.plugins.conftest import SAMPLE_PAGES, build_pdf

RERANKERS = ["mmr", "cross_encoder", "llm_rerank"]
QUESTION = "What is the capital of France?"
MINILM = "cross-encoder/ms-marco-MiniLM-L-6-v2"


@pytest.mark.parametrize("name", RERANKERS)
def test_the_app_registry_holds_the_package_reranker(name):
    assert registry.get(Stage.RERANK, name).__module__ == f"pandion.plugins.rerank.{name}"


def test_the_app_has_no_reranker_of_its_own():
    modules = {cls.__module__ for cls in registry.all_for(Stage.RERANK).values()}
    assert modules and all(m.startswith("pandion.") for m in modules)


@pytest.mark.parametrize("module", ["plugins.rerank", "plugins.rerank.mmr"])
def test_the_old_module_is_gone(module):
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


# -- warm-up ---------------------------------------------------------------------


def test_warm_up_loads_the_default_cross_encoder_on_the_cpu(monkeypatch):
    import pandion.plugins.rerank.cross_encoder as ce

    loaded: list = []
    monkeypatch.setattr(ce, "_load", lambda model_id, settings=None: loaded.append((model_id, settings)))
    warmup._warm_reranker()
    assert loaded == [(MINILM, APP_MODELS)]
    assert APP_MODELS.device == "cpu"


def test_a_failed_cross_encoder_download_is_logged_not_raised(monkeypatch, caplog):
    import pandion.plugins.rerank.cross_encoder as ce

    def boom(model_id, settings=None):
        raise OSError("no network")

    monkeypatch.setattr(ce, "_load", boom)
    with caplog.at_level(logging.ERROR):
        warmup._warm_reranker()
    assert "no network" in caplog.text


def test_the_warm_up_loads_the_reranker_after_the_others(monkeypatch):
    import pandion.embeddings as embeddings
    import pandion.plugins.parse.docling as docling_plugin

    calls: list[str] = []
    monkeypatch.setattr(
        docling_plugin,
        "_converter",
        lambda config: SimpleNamespace(initialize_pipeline=lambda fmt: calls.append("docling")),
    )
    monkeypatch.setattr(embeddings, "_load_model", lambda *args: calls.append("qwen"))
    monkeypatch.setattr(warmup, "_warm_reranker", lambda: calls.append("reranker"))
    warmup._warm()
    assert calls == ["docling", "qwen", "reranker"]


def test_the_reranker_warms_even_when_the_index_models_fail(monkeypatch, caplog):
    import pandion.plugins.parse.docling as docling_plugin

    def broken(config):
        raise RuntimeError("docling broke")

    calls: list[str] = []
    monkeypatch.setattr(docling_plugin, "_converter", broken)
    monkeypatch.setattr(warmup, "_warm_reranker", lambda: calls.append("reranker"))
    with caplog.at_level(logging.ERROR):
        warmup._warm()
    assert calls == ["reranker"]
    assert "docling broke" in caplog.text


# -- the same hits both ways -------------------------------------------------------

CHUNK = {"chunk_size": 70, "chunk_overlap": 10}
SEARCH = {"top_k": 20}
MMR = {"top_k": 5, "lambda_mult": 0.3}


def app_graph(sha: str, filename: str) -> Graph:
    """pdfium -> chunk -> lancedb -> dense -> mmr, as the Build page wires it."""
    return Graph(
        nodes=[
            Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": filename}),
            Node("q", Stage.QUERY, "text", {"text": QUESTION}),
            Node("parse", Stage.PARSE, "pdfium", {}),
            Node("chunk", Stage.CHUNK, "recursive_character", CHUNK),
            Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
            Node("dense", Stage.RETRIEVE, "dense", SEARCH),
            Node("mmr", Stage.RERANK, "mmr", MMR),
        ],
        edges=[
            Edge("src", "parse", "file"),
            Edge("parse", "chunk", "doc"),
            Edge("chunk", "index", "chunks"),
            Edge("index", "dense", "index"),
            Edge("dense", "mmr", "result"),
        ],
    )


def test_the_app_run_gives_the_same_hits_as_p_retrieve(tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    pdf = docs / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))

    deps = build_deps(
        artifacts_dir=tmp_path / "artifacts",
        sources_dir=tmp_path / "sources",
        web_dist=tmp_path / "web",
    )
    stored = deps.run_extras()["sources"].add(pdf)
    in_app = run(
        app_graph(stored.sha, stored.filename), deps.registry, deps.store,
        context_extras=deps.run_extras(),
    )
    assert in_app.ok
    app_result = RetrievalResult.model_validate(
        deps.store.load(in_app.nodes["mmr"].artifact.id, ArtifactType.RETRIEVAL_RESULT)
    )

    config = tmp_path / "pipeline.yaml"
    config.write_text(
        yaml.safe_dump(
            {
                "path": "./pandion",
                "index": {
                    "parse": {"use": "pdfium"},
                    "chunk": {"use": "recursive_character", **CHUNK},
                    "embed": {"use": "fake-deterministic"},
                    "store": {"use": "lancedb"},
                },
                "retrieve": {
                    "search": {"use": "dense", **SEARCH},
                    "rerank": {"use": "mmr", **MMR},
                },
            }
        ),
        encoding="utf-8",
    )
    p = Pipeline.from_file(config)
    p.index.run(docs)
    result = p.retrieve(QUESTION)

    assert result.stages["rerank"][0].artifact_id == in_app.nodes["mmr"].artifact.id
    assert result.stages["search"].artifact_id == in_app.nodes["dense"].artifact.id
    assert in_app.nodes["mmr"].status is NodeStatus.EXECUTED
    assert [(h.chunk.id, h.rank, h.score) for h in result.hits] == [
        (h.chunk.id, h.rank, h.score) for h in app_result.hits
    ]
    assert result.hits
