"""Pipeline.from_file(...).index.sync(folder): keep an index in step with a folder.

A temp folder of small PDFs, the fake embedder (no download), and a manifest
under the config's `path`. Each test changes the folder or the config and
checks what the sync says it did, what the index holds, and the manifest.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import lancedb
import pytest

from pandion import Pipeline
from pandion.manifest import MANIFEST, Manifest
from pdfs import SAMPLE_PAGES, build_pdf

CONFIG = """\
path: ./index
models:
  device: cpu
index:
  parse:
    use: pdfium
  chunk:
    use: recursive_character
    chunk_size: {chunk_size}
    chunk_overlap: 10
  embed:
    use: fake-deterministic
  store:
    use: lancedb
"""


def write_config(folder: Path, chunk_size: int = 70) -> Path:
    config = folder / "pipeline.yaml"
    config.write_text(CONFIG.format(chunk_size=chunk_size), encoding="utf-8")
    return config


@pytest.fixture
def setup(tmp_path: Path) -> tuple[Path, Path]:
    """A pipeline file and a folder of two PDFs, one of them in a subfolder."""
    config = write_config(tmp_path)
    docs = tmp_path / "docs"
    (docs / "guides").mkdir(parents=True)
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "guides" / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return config, docs


def sync(config: Path, docs: Path):
    return Pipeline.from_file(config).index.sync(docs)


def manifest(config: Path) -> dict:
    return json.loads((config.parent / "index" / MANIFEST).read_text(encoding="utf-8"))


def index_rows(report) -> list[str]:
    table = lancedb.connect(report.index.output).open_table("chunks")
    return sorted(r["id"] for r in table.to_arrow().to_pylist())


def chunk_ids(report, doc_id: str) -> list[str]:
    return sorted(c.id for c in report.documents[doc_id].stages["chunk"].output.chunks)


def statuses(report) -> set[str]:
    return {s.status for d in report.documents.values() for s in d.stages.values()} | {
        report.index.status
    }


def test_the_first_sync_adds_every_file_and_writes_the_manifest(setup):
    config, docs = setup

    report = sync(config, docs)

    assert report.ok
    assert report.added == ["guides/short.pdf", "report.pdf"]
    assert report.changed == report.removed == report.unchanged == []
    written = manifest(config)
    assert written["index_artifact"] == report.index.artifact_id
    assert len(written["index_recipe"]) == 64
    entry = written["documents"]["report.pdf"]
    assert entry["content_hash"] == hashlib.sha256((docs / "report.pdf").read_bytes()).hexdigest()
    assert entry["chunk_set"] == report.documents["report.pdf"].stages["chunk"].artifact_id


def test_a_sync_of_an_unchanged_folder_runs_nothing_but_cache_hits(setup):
    config, docs = setup
    first = sync(config, docs)

    second = sync(config, docs)

    assert statuses(second) == {"cached"}
    assert second.unchanged == ["guides/short.pdf", "report.pdf"]
    assert second.added == second.changed == second.removed == []
    assert not second.config_changed
    assert second.index.artifact_id == first.index.artifact_id


def test_a_new_file_is_added_to_the_index(setup):
    config, docs = setup
    sync(config, docs)
    (docs / "new.pdf").write_bytes(build_pdf([["Berlin is the capital of Germany."]]))

    report = sync(config, docs)

    assert report.added == ["new.pdf"]
    assert report.unchanged == ["guides/short.pdf", "report.pdf"]
    assert report.documents["report.pdf"].stages["parse"].status == "cached"
    assert set(chunk_ids(report, "new.pdf")) <= set(index_rows(report))
    assert "new.pdf" in manifest(config)["documents"]


def test_a_changed_file_replaces_its_old_pieces(setup):
    config, docs = setup
    first = sync(config, docs)
    old_pieces = chunk_ids(first, "guides/short.pdf")
    (docs / "guides" / "short.pdf").write_bytes(build_pdf([["Rome is the capital of Italy."]]))

    report = sync(config, docs)

    assert report.changed == ["guides/short.pdf"]
    assert report.unchanged == ["report.pdf"]
    rows = index_rows(report)
    assert set(chunk_ids(report, "guides/short.pdf")) <= set(rows)
    assert not set(old_pieces) & set(rows)
    pipeline = Pipeline.from_file(config)
    assert not pipeline.index.store.has(first.index.artifact_id)


def test_a_removed_file_has_its_pieces_deleted(setup):
    config, docs = setup
    first = sync(config, docs)
    gone = chunk_ids(first, "guides/short.pdf")
    (docs / "guides" / "short.pdf").unlink()

    report = sync(config, docs)

    assert report.removed == ["guides/short.pdf"]
    assert report.unchanged == ["report.pdf"]
    assert sorted(report.documents) == ["report.pdf"]
    assert not set(gone) & set(index_rows(report))
    assert sorted(manifest(config)["documents"]) == ["report.pdf"]
    # The old index held the removed pieces; it is gone from the store too.
    assert not Pipeline.from_file(config).index.store.has(first.index.artifact_id)


def test_a_changed_config_rebuilds_from_the_first_changed_step(setup):
    config, docs = setup
    first = sync(config, docs)
    recipe = manifest(config)["index_recipe"]
    write_config(config.parent, chunk_size=50)

    report = sync(config, docs)

    assert report.config_changed
    assert report.changed == ["guides/short.pdf", "report.pdf"]
    for doc in report.documents.values():
        assert doc.stages["parse"].status == "cached"
        assert doc.stages["chunk"].status == "executed"
    assert report.index.artifact_id != first.index.artifact_id
    assert manifest(config)["index_recipe"] != recipe


def test_a_missing_manifest_reads_as_empty(tmp_path):
    empty = Manifest.load(tmp_path / MANIFEST)

    assert empty.documents == {} and empty.index_artifact is None


def test_document_ids_use_forward_slashes_on_every_system(tmp_path):
    config = write_config(tmp_path)
    docs = tmp_path / "docs"
    deep = docs / "a" / "b"
    deep.mkdir(parents=True)
    (deep / "deep.pdf").write_bytes(build_pdf([["Deep in a nested folder."]]))

    report = sync(config, docs)

    assert report.added == ["a/b/deep.pdf"]
    assert list(manifest(config)["documents"]) == ["a/b/deep.pdf"]


def test_hidden_files_and_folders_are_ignored(setup):
    config, docs = setup
    (docs / ".hidden").mkdir()
    (docs / ".hidden" / "secret.pdf").write_bytes(build_pdf([["Hidden."]]))
    (docs / ".notes.pdf").write_bytes(build_pdf([["Also hidden."]]))

    report = sync(config, docs)

    assert sorted(manifest(config)["documents"]) == ["guides/short.pdf", "report.pdf"]
    assert report.added == ["guides/short.pdf", "report.pdf"]


def test_a_failed_sync_keeps_the_last_manifest_and_index(setup):
    config, docs = setup
    first = sync(config, docs)
    before = manifest(config)
    (docs / "broken.pdf").write_bytes(b"not a pdf at all")

    report = sync(config, docs)

    assert not report.ok
    assert manifest(config) == before
    assert Pipeline.from_file(config).index.store.has(first.index.artifact_id)
