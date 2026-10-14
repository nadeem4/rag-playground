"""The visitor cookie: minted by the server, and the key to a visitor's own uploads."""

from __future__ import annotations

import re

from playground.backend import visitor
from playground.backend.routes.sources import META_DIR, owners
from tests.api.conftest import build_pdf, make_client, read_sse, upload_pdf
from tests.api.test_v2_strategies import PIPELINE
from tests.steps.conftest import SAMPLE_PAGES


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
        mine.get("/api/settings/app")  # a demo upload needs the visitor cookie first
        body = upload_pdf(mine, "mine.pdf")
        sha = body["sha"]
        assert any(s["sha"] == sha for s in mine.get("/api/v2/documents").json())
        assert mine.get(f"/api/v2/documents/{sha}/pages/1").status_code == 200
        r = mine.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sha], "through": "parse"})
        assert r.status_code == 202
        read_sse(mine, r.json()["run_id"], prefix="/api/v2")

        assert all(s["sha"] != sha for s in theirs.get("/api/v2/documents").json())
        assert theirs.get(f"/api/v2/documents/{sha}/pages").status_code == 404
        assert theirs.get(f"/api/v2/documents/{sha}/pages/1").status_code == 404
        assert theirs.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sha]}).status_code == 403


def test_the_samples_stay_public_in_demo_mode(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as a, make_client(dirs) as b:
        sha = a.post("/api/sources/sample").json()["sha"]
        assert any(s["sha"] == sha for s in b.get("/api/v2/documents").json())
        assert b.get(f"/api/v2/documents/{sha}/pages/1").status_code == 200


def test_the_same_bytes_uploaded_by_two_visitors_belong_to_both(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as a, make_client(dirs) as b:
        a.get("/api/settings/app")
        b.get("/api/settings/app")
        sha = upload_pdf(a)["sha"]
        assert upload_pdf(b)["sha"] == sha
        for c in (a, b):
            assert c.get(f"/api/v2/documents/{sha}/pages/1").status_code == 200


def test_clearing_the_cookie_loses_access_and_gets_a_fresh_id(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as c:
        c.get("/api/settings/app")
        sha = upload_pdf(c)["sha"]
        old = c.cookies.get(visitor.COOKIE)
        c.cookies.clear()
        r = c.get("/api/v2/documents")
        assert r.status_code == 200 and all(s["sha"] != sha for s in r.json())
        assert c.cookies.get(visitor.COOKIE) not in (None, old)
        assert c.get(f"/api/v2/documents/{sha}/pages/1").status_code == 404


def test_outside_demo_mode_every_client_sees_every_upload(dirs):
    with make_client(dirs) as a, make_client(dirs) as b:
        sha = upload_pdf(a)["sha"]
        assert any(s["sha"] == sha for s in b.get("/api/v2/documents").json())
        assert b.get(f"/api/v2/documents/{sha}/pages/1").status_code == 200


# --- a crafted sha must never reach a filesystem path -------------------------


def test_a_crafted_sha_in_a_run_is_refused_not_500(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as c:
        r = c.post("/api/v2/runs", json={"config": PIPELINE, "documents": ["../../etc/passwd"]})
        assert r.status_code == 404 and "passwd" not in r.text


def test_owners_rejects_a_sha_that_is_not_a_valid_digest(tmp_path):
    assert owners(tmp_path, "../x") == {}


# --- a corrupted sidecar must never turn into a 500 ----------------------------


def test_a_corrupted_sidecar_is_skipped_not_500(client, dirs):
    sha = upload_pdf(client)["sha"]
    sidecar = dirs["sources"] / META_DIR / f"{sha}.json"
    sidecar.write_text("not json", encoding="utf-8")
    assert owners(dirs["sources"], sha) == {}
    r = client.get("/api/v2/documents")
    assert r.status_code == 200
    assert r.json() == []


# --- the cookie must survive the Hugging Face Space's cross-site iframe -------


def test_over_https_the_cookie_is_sent_in_a_cross_site_iframe(client):
    r = client.get("/api/settings/app", headers={"x-forwarded-proto": "https"})
    set_cookie = r.headers["set-cookie"].lower()
    assert "samesite=none" in set_cookie
    assert "secure" in set_cookie
    assert "partitioned" in set_cookie
    assert "httponly" in set_cookie and "path=/" in set_cookie and "max-age=31536000" in set_cookie


def test_over_plain_http_the_cookie_stays_lax_and_not_secure(client):
    set_cookie = client.get("/api/settings/app").headers["set-cookie"].lower()
    assert "samesite=lax" in set_cookie
    assert "secure" not in set_cookie
    assert "partitioned" not in set_cookie


# --- in demo mode an upload never mints; it needs a cookie from an earlier visit


def test_in_demo_mode_an_upload_without_a_cookie_is_refused_and_mints_nothing(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as c:
        c.cookies.clear()
        data = build_pdf(SAMPLE_PAGES)
        r = c.post("/api/v2/documents", files={"file": ("a.pdf", data, "application/pdf")})
        assert r.status_code == 400
        assert r.json()["detail"] == (
            "This browser sent no visitor id. Open the demo in its own tab or enable cookies, then try again."
        )
        assert "set-cookie" not in r.headers
        assert not (dirs["sources"] / META_DIR).exists()
        c.get("/api/settings/app")
        assert upload_pdf(c)["sha"]


def test_a_sidecar_without_a_filename_is_skipped_not_500(client, dirs):
    sha = upload_pdf(client)["sha"]
    sidecar = dirs["sources"] / META_DIR / f"{sha}.json"
    sidecar.write_text('{"sha": "%s", "size": 1}' % sha, encoding="utf-8")
    (dirs["sources"] / META_DIR / "odd.json").write_text('{"sha": 5, "filename": "x.pdf"}', encoding="utf-8")
    r = client.get("/api/v2/documents")
    assert r.status_code == 200
    assert r.json() == []
