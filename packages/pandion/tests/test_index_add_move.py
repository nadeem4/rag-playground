"""add, move, sort and documents(): one document at a time, by category."""

from __future__ import annotations

import copy
from pathlib import Path

import lancedb
import pytest
from pdfs import SAMPLE_PAGES, build_pdf
from pydantic import BaseModel

from pandion import Pipeline
from pandion.extend import ArtifactType, Element, ParsedDoc, PortSpec, Stage, Transform, raw_file, register
from pandion.manifest import MANIFEST
from pandion.registry import registry

INVOICE = {"when": {"use": "metadata", "key": "cms_type", "equals": "invoice"}, "category": "reports"}


def chunker(size: int) -> dict:
    return {"use": "recursive_character", "chunk_size": size, "chunk_overlap": 10}


def config(tmp_path: Path) -> dict:
    return {
        "path": str(tmp_path / "index"),
        "models": {"device": "cpu"},
        "categories": {
            "reports": {"parse": {"use": "pdfium"}, "chunk": chunker(70)},
            "text": {"parse": {"use": "pdfium"}, "chunk": chunker(50)},
        },
        "route": [INVOICE, {"category": "text"}],
        "index": {"embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}},
    }


def make(tmp_path: Path) -> Pipeline:
    return Pipeline.from_dict(copy.deepcopy(config(tmp_path)))


@pytest.fixture
def pdfs(tmp_path: Path) -> tuple[Path, Path]:
    folder = tmp_path / "pdfs"
    folder.mkdir()
    (folder / "a.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (folder / "b.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return folder / "a.pdf", folder / "b.pdf"


def rows(report) -> list[str]:
    table = lancedb.connect(report.index.output).open_table("chunks")
    return sorted(r["id"] for r in table.to_arrow().to_pylist())


def chunk_ids(report, doc_id: str) -> list[str]:
    return sorted(c.id for c in report.documents[doc_id].stages["chunk"].output.chunks)


def test_add_sorts_and_saves(tmp_path, pdfs):
    p = make(tmp_path)
    p.index.add(pdfs[0], metadata={"cms_type": "invoice"})
    [entry] = p.documents()
    assert (entry.id, entry.category) == ("a.pdf", "reports")
    assert entry.reason == "Rule 1: metadata cms_type equals invoice"
    assert entry.metadata == {"cms_type": "invoice"}
    assert entry.filename == "a.pdf" and len(entry.content_hash) == 64


def test_add_with_a_category_always_wins(tmp_path, pdfs):
    p = make(tmp_path)
    p.index.add(pdfs[0], category="text", metadata={"cms_type": "invoice"})
    assert (p.documents()[0].category, p.documents()[0].reason) == ("text", "Chosen when added")


def test_add_twice_is_refused(tmp_path, pdfs):
    p = make(tmp_path)
    p.index.add(pdfs[0])
    with pytest.raises(ValueError, match=r"`a.pdf` is already in the index. Use p.index.move"):
        p.index.add(pdfs[0])


def test_add_unknown_category_is_refused(tmp_path, pdfs):
    with pytest.raises(ValueError, match=r"memos.*reports, text"):
        make(tmp_path).index.add(pdfs[0], category="memos")


def test_add_keeps_other_documents_cached(tmp_path, pdfs):
    p = make(tmp_path)
    p.index.add(pdfs[0])
    report = p.index.add(pdfs[1])
    assert report.added == ["b.pdf"] and report.unchanged == ["a.pdf"]
    assert {s.status for s in report.documents["a.pdf"].stages.values()} == {"cached"}
    assert [d.id for d in p.documents()] == ["a.pdf", "b.pdf"]


def test_move_reruns_only_that_document(tmp_path, pdfs):
    p = make(tmp_path)
    p.index.add(pdfs[0], category="reports")
    first = p.index.add(pdfs[1], category="text")
    old_pieces = chunk_ids(first, "a.pdf")
    report = p.index.move("a.pdf", "text")
    assert report.changed == ["a.pdf"] and report.unchanged == ["b.pdf"]
    assert report.documents["b.pdf"].stages["chunk"].status == "cached"
    assert report.documents["a.pdf"].stages["chunk"].status == "executed"
    entry = p.documents()[0]
    assert (entry.category, entry.reason) == ("text", "Chosen when moved")
    assert report.index.artifact_id != first.index.artifact_id
    assert not set(old_pieces) & set(rows(report))
    assert set(chunk_ids(report, "a.pdf")) <= set(rows(report))
    assert not p.index.store.has(first.index.artifact_id)


def test_move_to_the_same_category_runs_nothing(tmp_path, pdfs):
    p = make(tmp_path)
    first = p.index.add(pdfs[0], category="text")
    report = p.index.move("a.pdf", "text")
    assert report.unchanged == ["a.pdf"] and report.documents == {} and report.index is None
    assert p.index.store.has(first.index.artifact_id)


def test_move_unknown_document_is_refused(tmp_path, pdfs):
    p = make(tmp_path)
    p.index.add(pdfs[0])
    with pytest.raises(ValueError, match=r"`z.pdf` is not in the index. The documents are: a.pdf"):
        p.index.move("z.pdf", "text")
    with pytest.raises(ValueError, match="memos"):
        p.index.move("a.pdf", "memos")


def test_sort_runs_nothing_and_writes_nothing(tmp_path, pdfs):
    p = make(tmp_path)
    got = p.index.sort(pdfs[0], metadata={"a.pdf": {"cms_type": "invoice"}})
    assert (got["a.pdf"].category, got["a.pdf"].reason) == ("reports", "Rule 1: metadata cms_type equals invoice")
    assert not (tmp_path / "index" / MANIFEST).exists()
    assert not (tmp_path / "index" / "artifacts").exists()


class MetaSettings(BaseModel):
    location: str = ""


class MetaSource(Transform[MetaSettings]):
    name = "test_meta_source"
    stage = Stage.SOURCE
    output = ArtifactType.RAW_FILE
    config_model = MetaSettings
    summary = "A text document that comes with a label."

    def apply(self, inputs, config, ctx):
        return raw_file(ctx, config.location.encode("utf-8"), "x.txt", metadata={"cms_type": "invoice"})


class NoSettings(BaseModel):
    pass


class LinesParser(Transform[NoSettings]):
    name = "test_meta_lines"
    stage = Stage.PARSE
    inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
    output = ArtifactType.PARSED_DOC
    config_model = NoSettings
    summary = "One block per line of a text file."

    def apply(self, inputs, config, ctx):
        lines = Path(inputs["file"]["path"]).read_text(encoding="utf-8").splitlines()
        return ParsedDoc(elements=[Element(id=f"l{i}", type="paragraph", text=t, order=i) for i, t in enumerate(lines)])


@pytest.fixture
def meta_source():
    from pandion.plugins import discover

    discover()
    register(MetaSource)
    register(LinesParser)
    yield
    registry._by_stage[Stage.SOURCE].pop("test_meta_source", None)
    registry._by_stage[Stage.PARSE].pop("test_meta_lines", None)


def test_source_metadata_routes_a_document(tmp_path, meta_source):
    data = config(tmp_path)
    data["index"]["source"] = {"use": "test_meta_source"}
    for c in data["categories"].values():
        c["parse"] = {"use": "test_meta_lines"}
    p = Pipeline.from_dict(data)
    report = p.index.run("hello", through="chunk")
    assert report.documents["hello"].category == "reports"
    assert report.documents["hello"].reason == "Rule 1: metadata cms_type equals invoice"


def test_documents_of_an_empty_pipeline_is_an_empty_list(tmp_path):
    assert make(tmp_path).documents() == []
