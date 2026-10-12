"""`upload` resolves a content-addressed file out of the run's sources folder."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from pandion.artifacts import ArtifactType
from pandion.plugins import discover
from pandion.ports import RunContext, Stage
from pandion.registry import registry
from pandion.sources import Sources

discover()


@pytest.fixture
def sources(tmp_path: Path) -> Path:
    root = tmp_path / "sources"
    root.mkdir()
    return root


def store(sources: Path, data: bytes, suffix: str) -> str:
    sha = hashlib.sha256(data).hexdigest()
    (sources / f"{sha}{suffix}").write_bytes(data)
    return sha


def run(sha: str = "", filename: str = "", root: Path | None = None):
    """Run `upload` with the sources folder handed in, as a run does."""
    cls = registry.get(Stage.SOURCE, "upload")
    extras = {} if root is None else {"sources": Sources(root)}
    ctx = RunContext(output_dir=Path("."), emit=lambda e: None, tmp=Path("."), extras=extras)
    return cls().apply({}, cls.config_model(sha=sha, filename=filename), ctx)


def test_registered_under_the_source_stage():
    cls = registry.get(Stage.SOURCE, "upload")
    assert cls.output is ArtifactType.RAW_FILE
    assert cls.inputs == {}


def test_returns_the_raw_file_payload(sources: Path, sample_pdf: Path):
    data = sample_pdf.read_bytes()
    sha = store(sources, data, ".pdf")

    out = run(sha=sha, filename="paper.pdf", root=sources)

    assert out == {
        "sha": sha,
        "filename": "paper.pdf",
        "path": str(sources / f"{sha}.pdf"),
        "mime": "application/pdf",
    }
    assert Path(out["path"]).read_bytes() == data


def test_mime_falls_back_for_unknown_extensions(sources: Path):
    sha = store(sources, b"hello", ".weird")
    assert run(sha=sha, filename="notes.weird", root=sources)["mime"] == "application/octet-stream"


def test_missing_sha_is_an_error(sources: Path):
    with pytest.raises(ValueError, match="sha"):
        run(filename="paper.pdf", root=sources)


def test_missing_file_is_an_error(sources: Path):
    with pytest.raises(FileNotFoundError):
        run(sha="0" * 64, filename="paper.pdf", root=sources)


def test_payload_is_json_serializable(sources: Path):
    import json

    sha = store(sources, b"hello", ".txt")
    json.dumps(run(sha=sha, filename="notes.txt", root=sources))


def test_a_run_with_no_sources_folder_says_how_to_pass_one(sources: Path):
    sha = store(sources, b"hello", ".txt")
    with pytest.raises(ValueError, match="sources"):
        run(sha=sha, filename="notes.txt")
