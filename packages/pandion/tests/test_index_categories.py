"""Each document's steps come from its category."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
from pydantic import BaseModel

from pandion.config import from_dict, to_dict
from pandion.extend import ArtifactType, Element, ParsedDoc, PortSpec, Stage, Transform, register
from pandion.pipeline import IndexPipeline, Pipeline, extras_for
from pandion.sources import SourceFile

SHA_A, SHA_B = "a" * 64, "b" * 64
DOCS = {"a.pdf": SourceFile(sha=SHA_A, filename="a.pdf"), "b.pdf": SourceFile(sha=SHA_B, filename="b.pdf")}

INDEX = {
    "embed": {"use": "qwen3-embedding-0.6b"},
    "store": {"use": "lancedb", "metric": "cosine", "build_fts": True},
}

NEW = {
    "path": "idx",
    "categories": {
        "reports": {
            "parse": {"use": "docling", "table_mode": "accurate"},
            "chunk": {"use": "layout_blocks", "max_tokens": 400},
        },
        "scans": {
            "parse": {"use": "docling", "do_ocr": True},
            "clean": [{"use": "dedupe_blocks"}],
            "chunk": {"use": "layout_blocks", "max_tokens": 300},
        },
        "text": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character", "chunk_size": 400},
        },
    },
    "route": [
        {"when": {"use": "file_type", "types": ["pdf"]}, "category": "scans"},
        {"category": "text"},
    ],
    "index": INDEX,
}

OLD = {
    "path": "idx",
    "index": {
        "parse": {"use": "pdfium"},
        "clean": [{"use": "dedupe_blocks"}],
        "chunk": {"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 80},
        **INDEX,
    },
}


def index(data=NEW) -> IndexPipeline:
    return Pipeline.from_dict(copy.deepcopy(data)).index


def nodes(graph):
    return {n.id: (n.stage.value, n.transform, n.config) for n in graph.nodes}


def test_graph_gives_each_document_its_categorys_steps():
    graph, _ = index().graph(DOCS, {"a.pdf": "reports", "b.pdf": "scans"})
    by_id = nodes(graph)
    assert by_id["a.pdf::parse"][1] == "docling" and by_id["a.pdf::parse"][2]["table_mode"] == "accurate"
    assert by_id["b.pdf::parse"][1] == "docling" and by_id["b.pdf::parse"][2]["do_ocr"] is True
    assert "b.pdf::clean.1" in by_id and "a.pdf::clean.1" not in by_id
    assert by_id["a.pdf::chunk"][2]["max_tokens"] == 400
    assert by_id["b.pdf::chunk"][2]["max_tokens"] == 300


def test_every_chunk_set_feeds_the_one_index_node():
    graph, _ = index().graph(DOCS, {"a.pdf": "reports", "b.pdf": "scans"})
    assert [n.id for n in graph.nodes].count("index") == 1
    into_index = [(e.src, e.dst) for e in graph.edges if e.dst == "index"]
    assert into_index == [("a.pdf::chunk", "index"), ("b.pdf::chunk", "index")]


#: The old-shape graph for two documents, as main builds it.
OLD_GRAPH = {
    "a.pdf::source": ("source", "upload", {"sha": SHA_A, "filename": "a.pdf"}),
    "a.pdf::parse": ("parse", "pdfium", {}),
    "a.pdf::clean.1": ("clean", "dedupe_blocks", {}),
    "a.pdf::chunk": ("chunk", "recursive_character", {"chunk_size": 400, "chunk_overlap": 80}),
    "b.pdf::source": ("source", "upload", {"sha": SHA_B, "filename": "b.pdf"}),
    "b.pdf::parse": ("parse", "pdfium", {}),
    "b.pdf::clean.1": ("clean", "dedupe_blocks", {}),
    "b.pdf::chunk": ("chunk", "recursive_character", {"chunk_size": 400, "chunk_overlap": 80}),
    "index": ("index", "lancedb", {"embedder": "qwen3-embedding-0.6b", "metric": "cosine", "build_fts": True}),
}


def test_old_file_graph_is_unchanged():
    graph, roles = index(OLD).graph(DOCS)
    assert nodes(graph) == OLD_GRAPH
    assert roles["b.pdf::clean.1"] == ("b.pdf", "clean.1")


def test_pin_wins_over_the_route_default():
    p = index()
    assert p.category_of("a.pdf") == "text"
    p.assign(categories={"a.pdf": "reports"})
    assert p.category_of("a.pdf") == "reports"
    by_id = nodes(p.graph(DOCS)[0])
    assert by_id["a.pdf::parse"][2]["table_mode"] == "accurate"
    assert by_id["b.pdf::parse"][1] == "pdfium"


def test_unknown_pin_is_refused():
    with pytest.raises(ValueError, match=r"memos.*reports, scans, text"):
        index().assign(categories={"a.pdf": "memos"})


def test_unsorted_document_is_in_the_routes_default_category():
    assert index().category_of("a.pdf") == "text"


def test_through_clean_stops_each_document_at_its_last_cleaner():
    p = index()
    assert p._last_step("clean") == "clean"
    assert p._stop_for("clean", p.config.index.categories["reports"]) == "parse"
    scans = p.config.index.categories["scans"]
    assert p._stop_for("clean", scans) == "clean.1"
    assert p._stop_for("clean.2", scans) == "clean.1"
    assert p._stop_for("clean.1", p.config.index.categories["reports"]) == "parse"
    assert p._stop_for("chunk", scans) == "chunk"


def test_through_a_step_no_category_has_is_refused():
    p = index()
    assert p._last_step("clean.1") == "clean.1"
    with pytest.raises(ValueError, match="clean.2"):
        p._last_step("clean.2")


class NoSettings(BaseModel):
    pass


@pytest.fixture
def _forget_parser():
    yield
    from pandion.registry import registry

    registry._by_stage[Stage.PARSE].pop("test_cat_lines", None)


def test_report_names_each_documents_category(tmp_path, _forget_parser):
    @register
    class Lines(Transform[NoSettings]):
        name = "test_cat_lines"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = NoSettings
        summary = "One block per line."

        def apply(self, inputs, config, ctx):
            lines = Path(inputs["file"]["path"]).read_text(encoding="utf-8").splitlines()
            return ParsedDoc(
                elements=[Element(id=f"l{i}", type="paragraph", text=t, order=i) for i, t in enumerate(lines)]
            )

    data = copy.deepcopy(NEW)
    data["path"] = str(tmp_path / "idx")
    data["categories"]["reports"]["parse"] = {"use": "test_cat_lines"}
    data["categories"]["scans"]["parse"] = {"use": "test_cat_lines"}
    p = Pipeline.from_dict(data).index
    (tmp_path / "docs").mkdir()
    for name in ("a.txt", "b.txt"):
        (tmp_path / "docs" / name).write_text("one\ntwo\n", encoding="utf-8")
    report = p.run(tmp_path / "docs", through="parse", categories={"a.txt": "reports", "b.txt": "scans"})
    assert report.documents["a.txt"].category == "reports"
    assert report.documents["b.txt"].category == "scans"
    assert "parse" in report.documents["a.txt"].stages
    assert p.category_of("a.txt") == "reports"
    with pytest.raises(ValueError, match="memos"):
        p.run(tmp_path / "docs", through="parse", categories={"a.txt": "memos"})


def test_extras_cover_every_category():
    from pandion.registry import registry

    config = from_dict(copy.deepcopy(NEW), base=Path("."))
    docling = registry.get(Stage.PARSE, "docling").extra
    assert docling
    config.index.categories["scans"].parse = ("pdfium", {})
    # Only "reports" still uses docling, and the route never sends a document there.
    assert docling in extras_for(config)
    config.index.categories["reports"].parse = ("pdfium", {})
    assert docling not in extras_for(config)


def test_pipeline_in_code_takes_categories_and_route():
    data = copy.deepcopy(NEW)
    p = Pipeline(
        path="idx",
        categories=data["categories"],
        route=data["route"],
        embed=INDEX["embed"],
        store=INDEX["store"],
    )
    assert p.to_dict() == to_dict(from_dict(copy.deepcopy(NEW), base=Path(".")))
    with pytest.raises(Exception, match="categories"):
        Pipeline(path="idx", parse="pdfium", categories=data["categories"], route=data["route"], store=INDEX["store"])


def test_retrieval_graph_uses_the_index_categories():
    data = copy.deepcopy(NEW)
    data["retrieve"] = {"search": {"use": "dense"}}
    p = Pipeline.from_dict(data)
    p.index.assign(categories={"a.pdf": "reports", "b.pdf": "scans"})
    index_nodes = nodes(p.index.graph(DOCS)[0])
    graph_nodes = nodes(p.retrieval.graph("q", documents=DOCS)[0])
    assert all(graph_nodes[k] == v for k, v in index_nodes.items())
    assert graph_nodes["a.pdf::chunk"][2]["max_tokens"] == 400


def test_retrieval_and_evaluation_see_the_categories_of_the_last_run(tmp_path, _forget_parser):
    @register
    class Lines(Transform[NoSettings]):
        name = "test_cat_lines"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = NoSettings
        summary = "One block per line."

        def apply(self, inputs, config, ctx):
            lines = Path(inputs["file"]["path"]).read_text(encoding="utf-8").splitlines()
            return ParsedDoc(
                elements=[Element(id=f"l{i}", type="paragraph", text=t, order=i) for i, t in enumerate(lines)]
            )

    data = copy.deepcopy(NEW)
    data["path"] = str(tmp_path / "idx")
    data["retrieve"] = {"search": {"use": "dense"}}
    for name in ("reports", "scans"):
        data["categories"][name]["parse"] = {"use": "test_cat_lines"}
    p = Pipeline.from_dict(data)
    (tmp_path / "docs").mkdir()
    for name in ("a.txt", "b.txt"):
        (tmp_path / "docs" / name).write_text("one\ntwo\n", encoding="utf-8")
    picks = {"a.txt": "reports", "b.txt": "scans"}
    p.index.run(tmp_path / "docs", through="parse", categories=picks)
    documents = p.index.documents
    ran = nodes(p.index.graph(documents)[0])
    assert nodes(p.retrieval.graph("q", documents=documents)[0]).items() >= ran.items()
    again = p.index._index(documents, stop="parse", remember=False)
    assert {d: r.category for d, r in again.documents.items()} == picks
