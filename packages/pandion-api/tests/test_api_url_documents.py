"""POST /documents/url, Policy.check_document, and the formats an upload may be.

A local HTTP server (`test_fetch.Server`, started and stopped by each test)
serves the pages. The default Policy fetches without `public_only`, so a page
on this machine can be stored; a Policy with it on refuses the same address.
"""

from __future__ import annotations

import hashlib

import pytest
from fastapi import HTTPException

from apihelpers import PIPELINE, finish, make_client, upload
from pandion_api import Policy
from pdfs import SAMPLE_PAGES, build_pdf
from test_fetch import Server


@pytest.fixture
def server():
    s = Server()
    yield s
    s.stop()


def hits(server: Server) -> int:
    """How many requests the server has answered."""
    return len(server.agents)


def add_url(client, url: str):
    return client.post("/documents/url", json={"url": url})


# --- the URL route ----------------------------------------------------------------


def test_a_url_is_stored_like_an_upload_with_its_origin(client, server):
    data = build_pdf(SAMPLE_PAGES)
    server.page("/papers/report.pdf", data, "application/pdf")
    url = server.url("/papers/report.pdf")

    r = add_url(client, url)

    assert r.status_code == 200, r.text
    sha = hashlib.sha256(data).hexdigest()
    assert r.json() == {
        "sha": sha,
        "filename": "127.0.0.1-papers-report.pdf",
        "size": len(data),
        "content_type": "application/pdf",
        "origin_url": url,
    }
    assert client.app.state.documents.file(sha).read_bytes() == data
    assert client.get("/documents").json() == [r.json()]


def test_an_html_page_is_stored_as_an_html_file(client, server):
    server.page("/guide", b"<html><body><h1>Guide</h1><p>Hi.</p></body></html>", "text/html; charset=utf-8")
    body = add_url(client, server.url("/guide")).json()
    assert body["filename"] == "127.0.0.1-guide.html" and body["content_type"] == "text/html"
    # The page routes read PDFs only: an HTML page is a plain 415, not a crash.
    assert client.get(f"/documents/{body['sha']}/pages").status_code == 415
    assert client.get(f"/documents/{body['sha']}/pages/1").status_code == 415
    r = client.get(f"/documents/{body['sha']}/pages/1/find", params={"text": "Hi"})
    assert r.status_code == 415


class PublicOnly(Policy):
    def public_endpoints_only(self, request):
        return True


def test_an_address_off_the_public_internet_is_403_with_the_guards_sentence(tmp_path, server):
    server.page("/r.pdf", build_pdf(SAMPLE_PAGES), "application/pdf")
    with make_client(tmp_path, PublicOnly()) as c:
        r = add_url(c, "https://127.0.0.1/r.pdf")
        assert r.status_code == 403
        assert r.json()["detail"] == "That address is not on the public internet, so it was not fetched."
        r = add_url(c, server.url("/r.pdf"))
        assert r.status_code == 403
        assert r.json()["detail"] == "Only https addresses on port 443 are fetched here."
        assert c.get("/documents").json() == []
    assert hits(server) == 0


class SmallPages(Policy):
    def max_url_bytes(self, request):
        return 100


def test_a_page_over_the_policys_byte_cap_is_413(tmp_path, server):
    server.page("/big.html", b"<p>" + b"x" * 500 + b"</p>", "text/html")
    with make_client(tmp_path, SmallPages()) as c:
        r = add_url(c, server.url("/big.html"))
    assert r.status_code == 413
    assert r.json()["detail"] == "The page is larger than the limit of 100 bytes, so it was not fetched."


def test_a_type_the_fetcher_does_not_take_is_415(client, server):
    server.page("/data.json", b'{"secret": "server text"}', "application/json")
    r = add_url(client, server.url("/data.json"))
    assert r.status_code == 415
    assert "server text" not in r.text
    assert r.json()["detail"].startswith("Pandion reads HTML, PDF, Word, text, PNG and JPG files from a URL")


def test_a_failed_fetch_is_502_and_never_echoes_what_the_server_said(client, server):
    server.routes["/gone"] = (404, {"Content-Type": "text/html"}, b"<p>internal stack trace</p>")
    r = add_url(client, server.url("/gone"))
    assert r.status_code == 502
    assert r.json()["detail"] == "The URL answered with status 404, so it was not fetched."
    assert "stack trace" not in r.text


def test_a_slow_page_is_504(client, server, monkeypatch):
    from pandion import fetch

    monkeypatch.setattr(fetch, "TIMEOUT", 0.3)
    server.delay = 1.0
    server.page("/slow", b"<p>late</p>", "text/html")
    r = add_url(client, server.url("/slow"))
    assert r.status_code == 504


@pytest.mark.parametrize("url", ["ftp://example.com/a.pdf", "not a url", "file:///etc/passwd"])
def test_a_url_that_is_not_http_is_400(client, url):
    r = add_url(client, url)
    assert r.status_code == 400
    assert r.json()["detail"] == "A URL document must start with http:// or https://."


def test_the_url_is_never_repeated_in_a_refusal(client, server):
    url = server.url("/gone?token=s3cret")
    r = add_url(client, url)
    assert r.status_code == 502 and "s3cret" not in r.text


class Refuses(Policy):
    """Refuses every fetch, and every document over 10 bytes."""

    def check_fetch(self, url, request):
        if request.headers.get("x-block"):
            raise HTTPException(429, "Too many fetches.")

    def check_document(self, data, filename, request):
        if len(data) > 10:
            raise HTTPException(413, f"{filename} is too big.")


def test_the_policy_can_refuse_a_fetch_before_it_is_sent(tmp_path, server):
    server.page("/a.txt", b"short", "text/plain")
    with make_client(tmp_path, Refuses()) as c:
        r = c.post("/documents/url", json={"url": server.url("/a.txt")}, headers={"X-Block": "1"})
        assert r.status_code == 429
    assert hits(server) == 0


def test_check_document_judges_uploads_and_fetched_pages_alike(tmp_path, server):
    server.page("/long.txt", b"far more than ten bytes", "text/plain")
    with make_client(tmp_path, Refuses()) as c:
        r = add_url(c, server.url("/long.txt"))
        assert r.status_code == 413 and r.json()["detail"] == "127.0.0.1-long.txt is too big."
        r = c.post("/documents", files={"file": ("up.txt", b"far more than ten bytes", "text/plain")})
        assert r.status_code == 413 and r.json()["detail"] == "up.txt is too big."
        assert upload(c, "ok.txt", b"tiny")["filename"] == "ok.txt"
        assert c.get("/documents").json()[0]["filename"] == "ok.txt"


def test_a_stored_url_document_is_used_by_its_id_and_never_fetched_again(client, server):
    server.page("/report.pdf", build_pdf(SAMPLE_PAGES), "application/pdf")
    sha = add_url(client, server.url("/report.pdf")).json()["sha"]
    assert hits(server) == 1

    finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    state, _ = finish(
        client,
        client.post("/ask", json={"config": PIPELINE, "documents": [sha], "question": "Paris?", "answer": False}),
    )
    assert state["result"]["ok"] is True and state["result"]["hits"]
    questions = [{"question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}]
    state, _ = finish(
        client, client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": questions})
    )
    assert state["ok"] is True
    assert client.get(f"/documents/{sha}/pages").status_code == 200
    assert client.get(f"/documents/{sha}/pages/1/find", params={"text": "Paris"}).status_code == 200

    assert hits(server) == 1


def test_the_status_follows_the_refusals_kind_not_its_words(client, monkeypatch):
    from pandion.extend import FetchRefused

    from pandion_api.routes import documents as route

    for kind, status in [
        ("bad_url", 400), ("not_https", 403), ("not_public", 403), ("too_big", 413), ("wrong_type", 415),
        ("too_many_redirects", 502), ("failed", 502), ("timed_out", 504),
    ]:
        def refuse(url, **_):
            raise FetchRefused("Reworded by a later Pandion.", kind)

        monkeypatch.setattr(route, "fetch_url", refuse)
        r = add_url(client, "https://example.com/a")
        assert (r.status_code, r.json()["detail"]) == (status, "Reworded by a later Pandion."), kind


class Watches(Policy):
    """Records whether the store's lock was held while each hook ran."""

    def __init__(self):
        self.held: list[tuple[str, bool]] = []

    def check_document(self, data, filename, request):
        self.held.append(("check_document", request.app.state.documents.lock.locked()))

    def on_uploaded(self, document, request):
        self.held.append(("on_uploaded", request.app.state.documents.lock.locked()))


def test_the_lock_is_held_from_check_document_until_the_record_is_written(tmp_path, server):
    """So two requests at once cannot both pass a cap that counts records."""
    policy = Watches()
    server.page("/a.txt", b"a page", "text/plain")
    with make_client(tmp_path, policy) as c:
        upload(c, "a.txt", b"an upload")
        assert add_url(c, server.url("/a.txt")).status_code == 200
    assert policy.held == [("check_document", True), ("on_uploaded", True)] * 2


class Slots(Policy):
    def __init__(self):
        self.events: list[str] = []

    def fetch_slot(self, request):
        import contextlib

        @contextlib.contextmanager
        def slot():
            self.events.append("in")
            try:
                yield
            finally:
                self.events.append("out")

        return slot()


def test_the_fetch_runs_inside_the_policys_slot_even_when_it_fails(tmp_path, server):
    policy = Slots()
    with make_client(tmp_path, policy) as c:
        assert add_url(c, server.url("/missing")).status_code == 502
    assert policy.events == ["in", "out"]


# --- which files an upload may be ---------------------------------------------------


@pytest.mark.parametrize(
    ("name", "data"),
    [
        ("notes.docx", b"PK\x03\x04 a word file"),
        ("deck.pptx", b"PK\x03\x04 a deck"),
        ("page.html", b"<p>Hi</p>"),
        ("page.HTM", b"<p>Hi</p>"),
        ("readme.md", b"# Title"),
        ("notes.txt", b"plain text"),
        ("scan.png", b"\x89PNG not really"),
        ("photo.jpeg", b"\xff\xd8 not really"),
    ],
)
def test_every_format_a_parser_reads_can_be_uploaded(client, name, data):
    assert upload(client, name, data)["filename"] == name


@pytest.mark.parametrize("name", ["budget.xlsx", "r.bin", "movie.MP4"])
def test_a_file_no_parser_reads_is_415_before_it_is_saved(client, tmp_path, name):
    r = client.post("/documents", files={"file": (name, b"some bytes", "application/octet-stream")})
    assert r.status_code == 415
    assert r.json()["detail"] == (
        "This server reads PDF, Word, PowerPoint, HTML, Markdown, text, PNG and JPG files, "
        "and this file is not one of them."
    )
    assert name not in r.text
    sources = tmp_path / "data" / "sources"
    assert not sources.exists() or not [p for p in sources.iterdir() if p.is_file()]
