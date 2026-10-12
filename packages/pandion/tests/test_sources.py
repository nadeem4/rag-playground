"""Source files are kept once, named by a fingerprint of their bytes."""

from __future__ import annotations

import hashlib

from pandion.sources import SourceFile, Sources


def test_a_file_is_stored_under_its_fingerprint_and_its_suffix(tmp_path):
    original = tmp_path / "Report.PDF"
    original.write_bytes(b"%PDF one")
    sources = Sources(tmp_path / "sources")

    added = sources.add(original)

    sha = hashlib.sha256(b"%PDF one").hexdigest()
    assert added == SourceFile(sha=sha, filename="Report.PDF")
    assert sources.path(sha, "Report.PDF") == tmp_path / "sources" / f"{sha}.PDF"
    assert sources.path(sha, "Report.PDF").read_bytes() == b"%PDF one"


def test_bytes_are_stored_the_same_way(tmp_path):
    sources = Sources(tmp_path)

    added = sources.add_bytes(b"hello", "notes.txt")

    assert added.sha == hashlib.sha256(b"hello").hexdigest()
    assert (tmp_path / f"{added.sha}.txt").read_bytes() == b"hello"


def test_the_same_bytes_are_one_file(tmp_path):
    sources = Sources(tmp_path / "s")
    a = sources.add_bytes(b"same", "a.pdf")
    b = sources.add_bytes(b"same", "b.pdf")

    assert a.sha == b.sha
    assert [p.name for p in (tmp_path / "s").iterdir()] == [f"{a.sha}.pdf"]


def test_a_stored_file_is_not_written_again(tmp_path):
    sources = Sources(tmp_path)
    first = sources.add_bytes(b"once", "a.pdf")
    stored = sources.path(first.sha, "a.pdf")
    before = stored.stat().st_mtime_ns

    sources.add_bytes(b"once", "a.pdf")

    assert stored.stat().st_mtime_ns == before
