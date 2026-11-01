"""The Source contract and the files source, with temp folders and no pipeline."""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

import pytest

from pandion.document_sources import FilesSource, Source, get_source, register_source, source_names


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    (tmp_path / "a").mkdir()
    (tmp_path / "b.txt").write_text("bee", encoding="utf-8")
    (tmp_path / "a" / "c.txt").write_text("sea", encoding="utf-8")
    return tmp_path


def test_files_source_lists_a_local_folder_sorted_with_forward_slashes(folder):
    assert [e.doc_id for e in FilesSource(str(folder)).list()] == ["a/c.txt", "b.txt"]


def test_a_files_source_is_a_source(folder):
    assert isinstance(FilesSource(str(folder)), Source)


def test_each_entry_has_a_version_and_its_metadata(folder):
    entry = next(e for e in FilesSource(str(folder)).list() if e.doc_id == "a/c.txt")
    assert entry.version
    assert entry.metadata["path"] == "a/c.txt"
    assert entry.metadata["content_type"] == "text/plain"


def test_the_version_changes_when_the_file_changes(folder):
    source = FilesSource(str(folder))
    before = {e.doc_id: e.version for e in source.list()}
    (folder / "b.txt").write_text("a longer bee", encoding="utf-8")
    after = {e.doc_id: e.version for e in source.list()}
    assert after["b.txt"] != before["b.txt"]
    assert after["a/c.txt"] == before["a/c.txt"]


def test_read_returns_the_bytes(folder):
    assert FilesSource(str(folder)).read("a/c.txt") == b"sea"


def test_the_same_file_name_in_two_folders_keeps_two_ids(folder):
    (folder / "d").mkdir()
    (folder / "d" / "c.txt").write_text("other", encoding="utf-8")
    ids = [e.doc_id for e in FilesSource(str(folder)).list()]
    assert "a/c.txt" in ids and "d/c.txt" in ids


def test_a_missing_location_says_so(tmp_path):
    with pytest.raises(ValueError, match="does not exist"):
        list(FilesSource(str(tmp_path / "nope")).list())


def test_a_missing_fsspec_names_the_extra(monkeypatch, folder):
    real = importlib.import_module

    def fake(name, *args, **kwargs):
        if name.split(".")[0] == "fsspec":
            raise ModuleNotFoundError(name="fsspec")
        return real(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", fake)
    with pytest.raises(Exception, match=r"pandion\[files\]"):
        list(FilesSource(str(folder)).list())


def test_register_source_refuses_a_duplicate_and_names_both_modules():
    class Other:
        name = "files"

    Other.__module__ = "elsewhere"
    with pytest.raises(ValueError, match="pandion.document_sources.*elsewhere"):
        register_source(Other)


def test_get_source_builds_by_name(folder):
    source = get_source("files", location=str(folder))
    assert isinstance(source, FilesSource)


def test_source_names_lists_files():
    assert "files" in source_names()


def test_importing_document_sources_loads_no_fsspec():
    code = "import sys, pandion.document_sources; assert 'fsspec' not in sys.modules"
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_files_is_listed_as_a_source_plugin():
    from pandion.plugins import plugin_listing

    rows = [r for r in plugin_listing() if r["kind"] == "source" and r["name"] == "files"]
    assert rows and rows[0]["level"] == "stable"
