"""IndexPipeline.sync_source: sync the source named in the pipeline file."""

from __future__ import annotations

from pathlib import Path

import pytest

from pandion import Pipeline
from pandion.manifest import MANIFEST
from pdfs import SAMPLE_PAGES, build_pdf


def pipeline(tmp_path: Path, docs: Path | None, **extra) -> Pipeline:
    data = {
        "path": str(tmp_path / "index"),
        "index": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
            "embed": {"use": "fake-deterministic"},
            "store": {"use": "lancedb"},
        },
    }
    if docs is not None:
        data["source"] = {"use": "files", "location": str(docs)}
    return Pipeline.from_dict({**data, **extra}, base=tmp_path)


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (folder / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return folder


def test_sync_source_indexes_the_files_in_the_source_block(tmp_path, docs):
    report = pipeline(tmp_path, docs).index.sync_source()
    assert sorted(report.added) == ["report.pdf", "short.pdf"]


def test_sync_source_without_a_source_block_says_so(tmp_path):
    with pytest.raises(ValueError, match="source:"):
        pipeline(tmp_path, None).index.sync_source()


def test_sync_source_refuses_an_empty_listing(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="listed no documents"):
        pipeline(tmp_path, empty).index.sync_source()
    assert not (tmp_path / "index" / MANIFEST).exists()


def test_a_second_sync_source_reads_nothing_new(tmp_path, docs):
    p = pipeline(tmp_path, docs)
    p.index.sync_source()
    report = p.index.sync_source()
    assert report.added == []
    assert sorted(report.unchanged) == ["report.pdf", "short.pdf"]


def test_sync_source_passes_credentials(tmp_path, docs, monkeypatch):
    p = pipeline(tmp_path, docs)
    seen = {}

    def spy(self, paths, *, credentials=None, **kwargs):
        seen["credentials"] = credentials
        seen["listed"] = [e.doc_id for e in paths.list()]

    monkeypatch.setattr(type(p.index), "sync", spy)
    p.index.sync_source(credentials={"openai": "k"})
    assert seen == {"credentials": {"openai": "k"}, "listed": ["report.pdf", "short.pdf"]}
