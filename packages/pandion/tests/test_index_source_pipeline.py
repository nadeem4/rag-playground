"""The pipeline hands the source's id and labels to the index step."""

from __future__ import annotations

from pathlib import Path

import pytest

from pandion import Pipeline
from pandion.embeddings import get_embedder
from pandion.index_store import NO_FILTER, open_binding
from pdfs import SAMPLE_PAGES, build_pdf


def pipeline(tmp_path: Path, docs: Path | None = None) -> Pipeline:
    data = {
        "path": str(tmp_path / "index"),
        "index": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
            "embed": {"use": "fake-deterministic"},
            "store": {"use": "lancedb"},
        },
        "retrieve": {"search": {"use": "dense", "top_k": 10}},
        "answer": {"use": "search"},
    }
    if docs is not None:
        data["source"] = {"use": "files", "location": str(docs)}
    return Pipeline.from_dict(data, base=tmp_path)


def metadata_by_doc(report, tmp_path: Path) -> dict[str, dict]:
    """Row metadata by the file's hash (a row holds the sha as its doc id)."""
    collection = open_binding(report.index.output, str(tmp_path / "index" / "index"))
    vector = get_embedder("fake-deterministic").embed(["anything"])[0]
    return {h.row.doc_id: h.row.metadata for h in collection.search_dense(vector, 50, NO_FILTER)}


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    folder = tmp_path / "docs"
    (folder / "hr").mkdir(parents=True)
    (folder / "hr" / "pay.pdf").write_bytes(build_pdf([["Salaries are paid on the last day of the month."]]))
    (folder / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return folder


def test_sync_from_a_source_puts_the_id_and_labels_on_rows(tmp_path, docs):
    p = pipeline(tmp_path, docs)
    report = p.index.sync_source()

    ids = {m["source_id"] for m in metadata_by_doc(report, tmp_path).values()}

    assert ids == {"hr/pay.pdf", "report.pdf"}
    # The files source's own labels come through too.
    assert {m["source_content_type"] for m in metadata_by_doc(report, tmp_path).values()} == {"application/pdf"}
    assert {m["source_path"] for m in metadata_by_doc(report, tmp_path).values()} == {"hr/pay.pdf", "report.pdf"}


def test_retrieve_after_sync_does_not_rebuild_the_index(tmp_path, docs):
    p = pipeline(tmp_path, docs)
    p.index.sync_source()

    assert pipeline(tmp_path, docs).retrieve("salaries").index.status == "cached"


def test_two_files_with_the_same_bytes_keep_the_first_id(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    for name in ("b.pdf", "a.pdf"):
        (folder / name).write_bytes(build_pdf([["Same bytes in both files."]]))
    p = pipeline(tmp_path, folder)
    report = p.index.sync_source()

    assert {m["source_id"] for m in metadata_by_doc(report, tmp_path).values()} == {"a.pdf"}


def test_an_uploaded_document_gets_its_name_as_source_id(tmp_path, docs):
    report = pipeline(tmp_path).index.sync(docs / "report.pdf")

    assert {m["source_id"] for m in metadata_by_doc(report, tmp_path).values()} == {"report.pdf"}


def test_labels_reach_rows_and_a_later_search_still_hits_the_cache(tmp_path, docs):
    p = pipeline(tmp_path)
    report = p.index.sync(docs, metadata={"report.pdf": {"owner": "hr", "roles": "hr"}})

    rows = metadata_by_doc(report, tmp_path)

    assert {m.get("source_owner") for m in rows.values()} == {"hr", None}
    assert not [k for m in rows.values() for k in m if k == "source_roles"]
    assert pipeline(tmp_path).retrieve("salaries").index.status == "cached"
