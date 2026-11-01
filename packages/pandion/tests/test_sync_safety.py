"""sync runs one at a time, and a file that cannot be indexed is skipped and listed."""

from __future__ import annotations

from pathlib import Path

import pytest
from pdfs import SAMPLE_PAGES, build_pdf
from test_sync import manifest, write_config

from pandion import Pipeline
from pandion.manifest import MANIFEST
from pandion.synclock import SyncBusy

BAD = b"%PDF-1.4 not really"


@pytest.fixture
def setup(tmp_path: Path) -> tuple[Path, Path]:
    config = write_config(tmp_path)
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "good.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return config, docs


def sync(config: Path, docs: Path):
    return Pipeline.from_file(config).index.sync(docs)


def test_a_sync_refuses_while_another_holds_the_lock(setup):
    config, docs = setup
    lock = config.parent / "index" / "sync.lock"
    lock.parent.mkdir(parents=True)
    lock.write_text("1", encoding="utf-8")
    with pytest.raises(SyncBusy, match="delete") as e:
        sync(config, docs)
    assert str(lock) in str(e.value)
    assert lock.exists()


def test_the_lock_is_released_after_a_sync_and_after_a_failing_one(setup):
    config, docs = setup
    lock = config.parent / "index" / "sync.lock"
    sync(config, docs)
    assert not lock.exists()
    (docs / "good.pdf").write_bytes(BAD)
    sync(config, docs)
    assert not lock.exists()


def test_a_bad_file_is_skipped_and_listed_and_the_rest_commit(setup):
    config, docs = setup
    (docs / "bad.pdf").write_bytes(BAD)
    report = sync(config, docs)
    assert isinstance(report.failed["bad.pdf"], str) and report.failed["bad.pdf"]
    assert report.added == ["good.pdf"]
    assert set(manifest(config)["documents"]) == {"good.pdf"}
    assert report.ok
    assert not report.complete


def test_the_bad_file_is_added_once_it_is_fixed(setup):
    config, docs = setup
    (docs / "bad.pdf").write_bytes(BAD)
    sync(config, docs)
    (docs / "bad.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    report = sync(config, docs)
    assert report.added == ["bad.pdf"]
    assert report.failed == {}
    assert report.complete


def test_a_pdf_behind_a_word_name_is_skipped_not_fatal(setup):
    config, docs = setup
    (docs / "notes.docx").write_bytes(build_pdf(SAMPLE_PAGES))
    report = sync(config, docs)
    assert "notes.docx" in report.failed
    assert report.added == ["good.pdf"]


def test_every_file_failing_commits_nothing(tmp_path):
    config = write_config(tmp_path)
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "bad.pdf").write_bytes(BAD)
    report = sync(config, docs)
    assert not (config.parent / "index" / MANIFEST).exists()
    assert "bad.pdf" in report.failed
    assert not report.ok


def test_a_file_that_starts_failing_leaves_the_index_without_it(setup):
    config, docs = setup
    (docs / "other.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    sync(config, docs)
    (docs / "other.pdf").write_bytes(BAD)
    report = sync(config, docs)
    assert "other.pdf" in report.failed
    assert report.removed == []
    assert set(manifest(config)["documents"]) == {"good.pdf"}


def test_the_good_documents_cost_only_cache_hits_after_a_failure(setup):
    config, docs = setup
    (docs / "bad.pdf").write_bytes(BAD)
    sync(config, docs)
    report = sync(config, docs)
    assert report.documents["good.pdf"].stages["parse"].status == "cached"
