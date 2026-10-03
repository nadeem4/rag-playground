"""The SPA shell must never be served from a stale browser cache after a publish,
while the hashed assets may be cached for a year."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.static import mount_spa


def _app(dist: Path) -> TestClient:
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>t</title>", encoding="utf-8")
    (dist / "assets" / "index-AbC123.js").write_text("console.log(1)", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    app = FastAPI()
    mount_spa(app, dist)
    return TestClient(app)


def test_the_shell_revalidates_on_every_visit(tmp_path):
    client = _app(tmp_path)
    for path in ("/", "/build", "/learn/parsing"):
        r = client.get(path)
        assert r.status_code == 200
        assert r.headers["cache-control"] == "no-cache", path


def test_hashed_assets_are_cached_for_a_year(tmp_path):
    client = _app(tmp_path)
    r = client.get("/assets/index-AbC123.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_other_files_revalidate(tmp_path):
    client = _app(tmp_path)
    r = client.get("/favicon.svg")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


def test_api_paths_are_never_the_shell(tmp_path):
    client = _app(tmp_path)
    assert client.get("/api/nothing").status_code == 404
