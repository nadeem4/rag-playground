"""API fixtures: an app wired to temp dirs, and an SSE reader.

Every test uses `with TestClient(app)` so one event loop lives for the whole
client. Runs are asyncio tasks on that loop; without the context manager each
request gets a throwaway loop and a background run dies with it.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.deps import build_deps
from api.main import create_app
from plugins.source import upload
from tests.plugins.conftest import SAMPLE_PAGES, build_pdf


@pytest.fixture(autouse=True)
def no_server_key(tmp_path: Path, monkeypatch) -> None:
    """Hide any real Anthropic key from every API test.

    The resolver reads the process environment and `<repo>/.env`; a developer's
    real key in either would otherwise flow into test runs. A test that wants a
    server-side key sets one explicitly.
    """
    from api import credentials

    monkeypatch.delenv(credentials.ENV_VAR, raising=False)
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO", raising=False)
    monkeypatch.setattr(credentials, "DOTENV_PATH", tmp_path / "no-such.env")


@pytest.fixture(autouse=True)
def no_model_warm_up(monkeypatch) -> None:
    """Never load a real model from an API test; start each test un-warmed."""
    from api import warmup

    monkeypatch.setattr(warmup, "_warm", lambda: None)
    monkeypatch.setattr(warmup, "_thread", None)


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch) -> dict[str, Path]:
    # build_deps rebinds the upload module's global; restore it afterwards.
    monkeypatch.setattr(upload, "SOURCES_DIR", upload.SOURCES_DIR)
    return {
        "artifacts": tmp_path / "artifacts",
        "sources": tmp_path / "sources",
        "web": tmp_path / "web-dist",
    }


def make_client(dirs, registry=None) -> TestClient:
    deps = build_deps(
        artifacts_dir=dirs["artifacts"],
        sources_dir=dirs["sources"],
        web_dist=dirs["web"],
        registry=registry,
    )
    return TestClient(create_app(deps))


@pytest.fixture
def client(dirs):
    with make_client(dirs) as c:
        yield c


def read_sse(client: TestClient, run_id: str, headers=None, params=None) -> list[dict]:
    """Consume a run's stream to its end; return parsed events with their ids."""
    out: list[dict] = []
    current: dict = {}
    with client.stream(
        "GET", f"/api/runs/{run_id}/events", headers=headers or {}, params=params
    ) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("id: "):
                current["_id"] = int(line[4:])
            elif line.startswith("data: "):
                current.update(json.loads(line[6:]))
            elif line == "" and current:
                out.append(current)
                current = {}
    if current:
        out.append(current)
    return out


def upload_pdf(client: TestClient, name: str = "sample.pdf") -> dict:
    data = build_pdf(SAMPLE_PAGES)
    r = client.post(
        "/api/sources", files={"file": (name, data, "application/pdf")}
    )
    assert r.status_code == 200, r.text
    assert r.json()["sha"] == hashlib.sha256(data).hexdigest()
    return r.json()


def ingest_graph(sha: str, filename: str, chunker: str = "recursive_character",
                 chunk_cfg: dict | None = None) -> dict:
    return {
        "nodes": [
            {"id": "src", "stage": "source", "transform": "upload",
             "config": {"sha": sha, "filename": filename}},
            {"id": "parse", "stage": "parse", "transform": "pdfium", "config": {}},
            {"id": "chunk", "stage": "chunk", "transform": chunker,
             "config": chunk_cfg or {}},
        ],
        "edges": [
            {"src": "src", "dst": "parse", "port": "file"},
            {"src": "parse", "dst": "chunk", "port": "doc"},
        ],
    }
