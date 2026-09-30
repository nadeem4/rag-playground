"""The visitor cookie: minted by the server, and the key to a visitor's own uploads."""

from __future__ import annotations

import re

from api import visitor
from tests.api.conftest import ingest_graph, make_client, upload_pdf


def demo_on(monkeypatch) -> None:
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")


def test_settings_app_mints_a_cookie_when_there_is_none(client):
    r = client.get("/api/settings/app")
    assert r.status_code == 200
    value = r.cookies.get(visitor.COOKIE)
    assert value and re.fullmatch(r"[A-Za-z0-9_-]{32}", value)
    set_cookie = r.headers["set-cookie"].lower()
    assert "httponly" in set_cookie and "samesite=lax" in set_cookie and "path=/" in set_cookie
    # and does not mint again when one is present
    r2 = client.get("/api/settings/app")
    assert "set-cookie" not in r2.headers


def test_a_bad_cookie_value_is_replaced(client):
    client.cookies.set(visitor.COOKIE, "nope; drop table")
    r = client.get("/api/settings/app")
    assert r.cookies.get(visitor.COOKIE) not in (None, "nope; drop table")


def test_upload_mints_a_cookie_too(client):
    body = upload_pdf(client)
    assert client.cookies.get(visitor.COOKIE)
    assert body["sha"]


def test_in_demo_mode_an_upload_is_private_to_its_browser(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as mine, make_client(dirs) as theirs:
        body = upload_pdf(mine, "mine.pdf")
        sha = body["sha"]
        assert any(s["sha"] == sha for s in mine.get("/api/sources").json())
        assert mine.get(f"/api/sources/{sha}/pages/1.png").status_code == 200
        assert mine.post("/api/runs", json={"graph": ingest_graph(sha, "mine.pdf")}).status_code == 202

        assert all(s["sha"] != sha for s in theirs.get("/api/sources").json())
        assert theirs.get(f"/api/sources/{sha}/pages").status_code == 404
        assert theirs.get(f"/api/sources/{sha}/pages/1.png").status_code == 404
        assert theirs.post("/api/runs", json={"graph": ingest_graph(sha, "mine.pdf")}).status_code == 403


def test_the_samples_stay_public_in_demo_mode(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as a, make_client(dirs) as b:
        sha = a.post("/api/sources/sample").json()["sha"]
        assert any(s["sha"] == sha for s in b.get("/api/sources").json())
        assert b.get(f"/api/sources/{sha}/pages/1.png").status_code == 200


def test_the_same_bytes_uploaded_by_two_visitors_belong_to_both(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as a, make_client(dirs) as b:
        sha = upload_pdf(a)["sha"]
        assert upload_pdf(b)["sha"] == sha
        for c in (a, b):
            assert c.get(f"/api/sources/{sha}/pages/1.png").status_code == 200


def test_clearing_the_cookie_loses_access_and_gets_a_fresh_id(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as c:
        sha = upload_pdf(c)["sha"]
        old = c.cookies.get(visitor.COOKIE)
        c.cookies.clear()
        r = c.get("/api/sources")
        assert r.status_code == 200 and all(s["sha"] != sha for s in r.json())
        assert c.cookies.get(visitor.COOKIE) not in (None, old)
        assert c.get(f"/api/sources/{sha}/pages/1.png").status_code == 404


def test_outside_demo_mode_every_client_sees_every_upload(dirs):
    with make_client(dirs) as a, make_client(dirs) as b:
        sha = upload_pdf(a)["sha"]
        assert any(s["sha"] == sha for s in b.get("/api/sources").json())
        assert b.get(f"/api/sources/{sha}/pages/1.png").status_code == 200
