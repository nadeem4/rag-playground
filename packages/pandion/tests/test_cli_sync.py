"""pandion sync: the summary line and the exit codes, run as a person runs it."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from pandion.cli import sync_line
from pandion.pipeline import SyncReport
from pdfs import SAMPLE_PAGES, build_pdf

KEYS = ["event", "ok", "added", "changed", "removed", "unchanged", "failed", "duration_s", "tokens"]


def pandion(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "pandion.cli", *args],
        cwd=cwd, capture_output=True, text=True, timeout=600, encoding="utf-8",
    )


def write(folder: Path, source: bool = True) -> None:
    data = {
        "path": "./index",
        "index": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
            "embed": {"use": "fake-deterministic"},
            "store": {"use": "lancedb"},
        },
    }
    if source:
        data["source"] = {"use": "files", "location": "./docs"}
    (folder / "pipeline.yaml").write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    write(tmp_path)
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return tmp_path


def test_sync_line_has_the_summary_keys():
    line = sync_line(SyncReport(documents={}, index=None, added=["a"], unchanged=["b", "c"]), 1.23456)
    assert "\n" not in line
    data = json.loads(line)
    assert list(data) == KEYS
    assert data["event"] == "sync" and data["added"] == 1 and data["unchanged"] == 2
    assert data["duration_s"] == 1.23 and data["tokens"] == 0


def test_sync_prints_one_summary_line_and_exits_0(folder):
    done = pandion("sync", "pipeline.yaml", cwd=folder)
    assert done.returncode == 0, done.stderr
    lines = done.stdout.strip().splitlines()
    assert len(lines) == 1
    data = json.loads(lines[0])
    assert data["added"] == 2 and data["ok"] is True and data["failed"] == 0


def test_sync_twice_reports_unchanged(folder):
    pandion("sync", "pipeline.yaml", cwd=folder)
    data = json.loads(pandion("sync", "pipeline.yaml", cwd=folder).stdout)
    assert data["added"] == 0 and data["unchanged"] == 2


def test_sync_exit_codes(folder, tmp_path):
    (folder / "docs" / "broken.docx").write_bytes(build_pdf(SAMPLE_PAGES))
    skipped = pandion("sync", "pipeline.yaml", cwd=folder)
    assert skipped.returncode == 1
    assert json.loads(skipped.stdout)["failed"] == 1
    assert "broken.docx" in skipped.stderr

    empty = tmp_path / "empty"
    empty.mkdir()
    write(empty)
    (empty / "docs").mkdir()
    refused = pandion("sync", "pipeline.yaml", cwd=empty)
    assert refused.returncode == 2 and "listed no documents" in refused.stderr and not refused.stdout

    bare = tmp_path / "bare"
    bare.mkdir()
    write(bare, source=False)
    missing = pandion("sync", "pipeline.yaml", cwd=bare)
    assert missing.returncode == 2 and "source:" in missing.stderr


def test_sync_reads_a_relative_location_from_the_pipeline_files_folder(folder, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    done = pandion("sync", str(folder / "pipeline.yaml"), cwd=elsewhere)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["added"] == 2
