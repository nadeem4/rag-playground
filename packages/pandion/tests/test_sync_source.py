"""index.sync with a Source: only new and changed entries are read."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pandion import Pipeline
from pandion.document_sources import FilesSource
from pandion.manifest import MANIFEST
from pdfs import SAMPLE_PAGES, build_pdf
from test_sync import write_config


class Counting(FilesSource):
    name = "counting"

    def __init__(self, location: str) -> None:
        super().__init__(location)
        self.reads: list[str] = []

    def read(self, doc_id: str) -> bytes:
        self.reads.append(doc_id)
        return super().read(doc_id)


@pytest.fixture
def setup(tmp_path: Path):
    config = write_config(tmp_path)
    docs = tmp_path / "docs"
    (docs / "guides").mkdir(parents=True)
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "guides" / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return config, docs, Counting(str(docs))


def manifest(config: Path) -> dict:
    return json.loads((config.parent / "index" / MANIFEST).read_text(encoding="utf-8"))


def sync(config: Path, source):
    return Pipeline.from_file(config).index.sync(source)


def test_the_first_sync_of_a_source_adds_every_entry_and_records_versions(setup):
    config, _, source = setup
    report = sync(config, source)
    assert report.added == ["guides/short.pdf", "report.pdf"]
    versions = {e.doc_id: e.version for e in source.list()}
    for doc_id, entry in manifest(config)["documents"].items():
        assert entry["version"] == versions[doc_id]


def test_an_unchanged_source_is_not_read_again(setup):
    config, _, source = setup
    sync(config, source)
    source.reads.clear()
    report = sync(config, source)
    assert source.reads == []
    assert report.unchanged == ["guides/short.pdf", "report.pdf"]


def test_a_changed_version_is_read_and_reported_changed(setup):
    config, docs, source = setup
    sync(config, source)
    source.reads.clear()
    (docs / "report.pdf").write_bytes(build_pdf([["A new report about Rome."]]))
    report = sync(config, source)
    assert source.reads == ["report.pdf"]
    assert report.changed == ["report.pdf"]


def test_a_touched_file_with_the_same_bytes_is_unchanged_but_its_version_updates(setup):
    config, docs, source = setup
    sync(config, source)
    old = manifest(config)["documents"]["report.pdf"]["version"]
    path = docs / "report.pdf"
    path.write_bytes(path.read_bytes())
    stat = path.stat()
    os.utime(path, (stat.st_atime, stat.st_mtime + 100))
    report = sync(config, source)
    assert "report.pdf" in report.unchanged
    assert manifest(config)["documents"]["report.pdf"]["version"] != old


def test_a_removed_entry_is_reported_removed(setup):
    config, docs, source = setup
    sync(config, source)
    (docs / "guides" / "short.pdf").unlink()
    assert sync(config, source).removed == ["guides/short.pdf"]


def test_new_documents_get_the_entry_metadata_as_labels(setup):
    config, _, source = setup
    sync(config, source)
    assert manifest(config)["documents"]["report.pdf"]["metadata"]["path"] == "report.pdf"


def test_missing_stored_bytes_are_read_again(setup):
    config, _, source = setup
    sync(config, source)
    for stored in (config.parent / "index" / "sources").iterdir():
        stored.unlink()
    source.reads.clear()
    sync(config, source)
    assert sorted(source.reads) == ["guides/short.pdf", "report.pdf"]


def test_an_empty_listing_is_refused_and_the_index_is_kept(setup):
    config, docs, source = setup
    sync(config, source)
    path = config.parent / "index" / MANIFEST
    kept = path.read_bytes()
    for f in [docs / "report.pdf", docs / "guides" / "short.pdf"]:
        f.unlink()
    with pytest.raises(ValueError, match="listed no documents"):
        sync(config, source)
    assert path.read_bytes() == kept


def test_a_repeated_id_is_refused(setup):
    config, docs, _ = setup

    class Twice(FilesSource):
        def list(self):
            entries = list(super().list())
            return entries + entries[:1]

    with pytest.raises(ValueError, match="twice"):
        sync(config, Twice(str(docs)))


def test_a_source_given_to_a_pipeline_with_another_source_step_is_refused(setup):
    config, _, source = setup
    p = Pipeline.from_file(config)
    p.config.index.source = ("path", {})
    with pytest.raises(ValueError, match="local files"):
        p.index.sync(source)


def test_the_same_file_name_in_two_folders_indexes_both(tmp_path):
    config = write_config(tmp_path)
    docs = tmp_path / "docs"
    for folder, text in (("a", "Paris is in France."), ("b", "Rome is in Italy.")):
        (docs / folder).mkdir(parents=True)
        (docs / folder / "report.pdf").write_bytes(build_pdf([[text]]))
    report = sync(config, FilesSource(str(docs)))
    assert report.added == ["a/report.pdf", "b/report.pdf"]
    assert sorted(manifest(config)["documents"]) == ["a/report.pdf", "b/report.pdf"]


class Unreadable(Counting):
    name = "unreadable"

    def read(self, doc_id: str) -> bytes:
        if doc_id == "report.pdf":
            raise PermissionError("denied")
        return super().read(doc_id)


def test_an_entry_that_cannot_be_read_is_listed_and_the_rest_index(setup):
    config, docs, _ = setup
    report = sync(config, Unreadable(str(docs)))
    assert list(report.failed) == ["report.pdf"]
    assert "denied" in report.failed["report.pdf"]
    assert report.added == ["guides/short.pdf"]
    assert report.removed == []
    assert report.ok and not report.complete
