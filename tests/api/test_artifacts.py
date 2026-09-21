"""Artifacts, cache clearing, static SPA serving, and the CLI entry point."""

from __future__ import annotations

import json
import subprocess
import sys

from core.artifacts import Artifact, ArtifactType
from tests.api.conftest import ingest_graph, make_client, read_sse, upload_pdf


def run_ingest(client) -> dict[str, str]:
    src = upload_pdf(client)
    r = client.post("/api/runs", json={"graph": ingest_graph(src["sha"], src["filename"])})
    events = read_sse(client, r.json()["run_id"])
    return {
        e["node_id"]: e["artifact_id"] for e in events if e["event"] == "node_finished"
    }


def test_artifact_meta(client):
    ids = run_ingest(client)
    r = client.get(f"/api/artifacts/{ids['chunk']}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == ids["chunk"]
    assert body["type"] == "chunk_set"
    assert body["meta"]["transform"] == "recursive_character"
    assert body["meta"]["node_id"] == "chunk"


def test_artifact_payload(client):
    ids = run_ingest(client)
    parsed = client.get(f"/api/artifacts/{ids['parse']}/payload").json()
    assert "Paris" in json.dumps(parsed)
    chunks = client.get(f"/api/artifacts/{ids['chunk']}/payload").json()
    assert chunks["chunks"]


def test_unknown_artifact_is_404(client):
    unknown = "f" * 64
    assert client.get(f"/api/artifacts/{unknown}").status_code == 404
    assert client.get(f"/api/artifacts/{unknown}/payload").status_code == 404


def test_malformed_artifact_id_is_404(client):
    assert client.get("/api/artifacts/..%2F..%2Fetc").status_code == 404
    assert client.get("/api/artifacts/xyz/payload").status_code == 404


def test_index_payload_is_its_descriptor(client):
    # An index artifact is a directory; the payload endpoint returns the
    # descriptor rather than trying to serialize a database.
    src = upload_pdf(client)
    g = ingest_graph(src["sha"], src["filename"])
    g["nodes"].append(
        {
            "id": "index",
            "stage": "index",
            "transform": "lancedb",
            "config": {"embedder": "fake-deterministic"},
        }
    )
    g["edges"].append({"src": "chunk", "dst": "index", "port": "chunks"})
    r = client.post("/api/runs", json={"graph": g})
    events = read_sse(client, r.json()["run_id"])
    aid = next(
        e["artifact_id"]
        for e in events
        if e["event"] == "node_finished" and e["node_id"] == "index"
    )

    r = client.get(f"/api/artifacts/{aid}/payload")
    assert r.status_code == 200
    body = r.json()
    assert "dense" in body["backends"] and body["doc_count"] > 0
    assert client.get(f"/api/artifacts/{aid}").json()["type"] == "index"


def test_index_without_descriptor_is_404(client):
    store = client.app.state.deps.store
    aid = "a" * 64
    store.put(Artifact(aid, ArtifactType.INDEX, {}), lambda d: None)
    assert client.get(f"/api/artifacts/{aid}/payload").status_code == 404


def test_delete_cache_frees_everything(client):
    ids = run_ingest(client)
    r = client.delete("/api/cache")
    assert r.status_code == 200
    body = r.json()
    assert body["artifacts"] == 3
    assert body["bytes"] > 0
    assert body["complete"] is True
    assert client.get(f"/api/artifacts/{ids['chunk']}").status_code == 404


def test_delete_empty_cache(client):
    assert client.delete("/api/cache").json() == {
        "artifacts": 0,
        "bytes": 0,
        "complete": True,
    }


def test_delete_cache_retries_on_permission_error(client, monkeypatch):
    run_ingest(client)
    store = client.app.state.deps.store
    real_clear = store.clear
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise PermissionError("handle open")
        real_clear()

    monkeypatch.setattr(store, "clear", flaky)
    monkeypatch.setattr("api.routes.artifacts.RETRY_DELAY_S", 0)
    body = client.delete("/api/cache").json()
    assert len(calls) == 3
    assert body["complete"] is True and body["artifacts"] == 3


# ---------------------------------------------------------------------------
# static SPA
# ---------------------------------------------------------------------------


def test_missing_build_serves_instructions(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "npm run build" in r.text
    assert "—" not in r.text  # no em-dashes
    assert "npm run build" in client.get("/compare").text


def test_built_spa_is_served_with_fallback(dirs):
    dist = dirs["web"]
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>SPA</html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    with make_client(dirs) as client:
        assert client.get("/").text == "<html>SPA</html>"
        assert client.get("/assets/app.js").text == "console.log(1)"
        assert client.get("/compare/deep/route").text == "<html>SPA</html>"
        # the API is never shadowed by the fallback
        assert client.get("/api/nope").status_code == 404
        assert client.get("/api/registry").status_code == 200


def test_static_does_not_escape_dist(dirs):
    dist = dirs["web"]
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html>SPA</html>", encoding="utf-8")
    (dirs["web"].parent / "secret.txt").write_text("nope", encoding="utf-8")
    with make_client(dirs) as client:
        assert "nope" not in client.get("/..%2Fsecret.txt").text


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_help():
    out = subprocess.run(
        [sys.executable, "-m", "api.cli", "--help"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    for flag in ("--port", "--no-browser", "--reload"):
        assert flag in out


def test_cli_starts_uvicorn_on_localhost(monkeypatch):
    from api import cli

    seen = {}
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, **kw: seen.update(app=app, **kw))
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    cli.main(["--port", "9123", "--no-browser"])
    assert seen["app"] == "api.main:app"
    assert seen["host"] == "127.0.0.1" and seen["port"] == 9123
    assert seen["reload"] is False
    assert opened == []


def test_entry_point_and_package_are_declared():
    import tomllib
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["scripts"]["rag-playground"] == "api.cli:main"
    assert "api" in project["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
