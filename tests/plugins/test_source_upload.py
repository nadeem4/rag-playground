"""`upload` resolves a content-addressed file out of the global sources dir."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from core.artifacts import ArtifactType
from core.ports import Stage
from core.registry import registry
from plugins.source import upload as upload_mod


@pytest.fixture
def sources(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "sources"
    root.mkdir()
    monkeypatch.setattr(upload_mod, "SOURCES_DIR", root)
    return root


def store(sources: Path, data: bytes, suffix: str) -> str:
    sha = hashlib.sha256(data).hexdigest()
    (sources / f"{sha}{suffix}").write_bytes(data)
    return sha


def run(sha: str = "", filename: str = "", ctx=None):
    cls = registry.get(Stage.SOURCE, "upload")
    return cls().apply({}, cls.config_model(sha=sha, filename=filename), ctx)


def test_registered_under_the_source_stage():
    cls = registry.get(Stage.SOURCE, "upload")
    assert cls.output is ArtifactType.RAW_FILE
    assert cls.inputs == {}


def test_returns_the_raw_file_payload(sources: Path, sample_pdf: Path):
    data = sample_pdf.read_bytes()
    sha = store(sources, data, ".pdf")

    out = run(sha=sha, filename="paper.pdf")

    assert out == {
        "sha": sha,
        "filename": "paper.pdf",
        "path": str(sources / f"{sha}.pdf"),
        "mime": "application/pdf",
    }
    assert Path(out["path"]).read_bytes() == data


def test_mime_falls_back_for_unknown_extensions(sources: Path):
    sha = store(sources, b"hello", ".weird")
    assert run(sha=sha, filename="notes.weird")["mime"] == "application/octet-stream"


def test_missing_sha_is_an_error(sources: Path):
    with pytest.raises(ValueError, match="sha"):
        run(filename="paper.pdf")


def test_missing_file_is_an_error(sources: Path):
    with pytest.raises(FileNotFoundError):
        run(sha="0" * 64, filename="paper.pdf")


def test_payload_is_json_serializable(sources: Path):
    import json

    sha = store(sources, b"hello", ".txt")
    json.dumps(run(sha=sha, filename="notes.txt"))
