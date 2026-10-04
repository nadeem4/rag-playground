"""An upload's own bytes (`GET /api/sources/{sha}/file`), so Library can export a
saved item with its document. Readable exactly where the pages are: on the
demo, a sample or the caller's own upload; locally, any file."""

from __future__ import annotations

from api import sample_set
from tests.api.conftest import build_pdf, make_client, upload_pdf
from tests.plugins.conftest import SAMPLE_PAGES


def demo_on(monkeypatch) -> None:
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")


def test_the_file_comes_back_byte_for_byte(client):
    sha = upload_pdf(client, "notes.pdf")["sha"]
    r = client.get(f"/api/sources/{sha}/file")
    assert r.status_code == 200
    assert r.content == build_pdf(SAMPLE_PAGES)
    assert r.headers["content-type"] == "application/pdf"


def test_an_unknown_or_malformed_sha_is_404(client):
    assert client.get("/api/sources/" + "0" * 64 + "/file").status_code == 404
    assert client.get("/api/sources/nope/file").status_code == 404


def test_demo_serves_your_own_upload_privately(client, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    sha = upload_pdf(client)["sha"]
    r = client.get(f"/api/sources/{sha}/file")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, no-store"


def test_demo_never_serves_another_visitors_upload(dirs, monkeypatch):
    with make_client(dirs) as owner:
        sha = upload_pdf(owner)["sha"]
    demo_on(monkeypatch)
    with make_client(dirs) as stranger:
        stranger.get("/api/settings/app")
        assert stranger.get(f"/api/sources/{sha}/file").status_code == 404


def test_demo_serves_a_sample(client, monkeypatch):
    demo_on(monkeypatch)
    sha = client.post("/api/sources/sample").json()["sha"]
    assert sha == sample_set.default_sample().sha
    r = client.get(f"/api/sources/{sha}/file")
    assert r.status_code == 200
    assert r.content == sample_set.default_sample().pdf.read_bytes()
