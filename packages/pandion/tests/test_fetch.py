"""`pandion.fetch.fetch_url`: one page a user asked for, behind a guard.

A local HTTP server (started and stopped by each test that needs it) serves
pages, redirects and slow answers. The guard's address checks run against a
patched resolver, so no test here touches DNS or the internet.
"""

from __future__ import annotations

import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from pandion import __version__, endpoints, fetch
from pandion.fetch import FetchRefused, fetch_url

PUBLIC_V4 = "104.18.2.115"
PRIVATE_V4 = "10.0.0.5"
BIG = 10_000_000


class Server:
    """A local server whose routes map a path to (status, headers, body)."""

    def __init__(self) -> None:
        self.routes: dict[str, tuple[int, dict[str, str], bytes]] = {}
        self.delay = 0.0
        self.agents: list[str] = []
        routes, server = self.routes, self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_GET(self) -> None:  # noqa: N802
                server.agents.append(self.headers.get("User-Agent", ""))
                if server.delay:
                    time.sleep(server.delay)
                status, headers, body = routes.get(self.path, (404, {}, b""))
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                try:
                    self.wfile.write(body)
                except OSError:
                    pass

            def log_message(self, *args) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}{path}"

    def page(self, path: str, body: bytes, content_type: str, length: bool = True) -> None:
        headers = {"Content-Type": content_type}
        if length:
            headers["Content-Length"] = str(len(body))
        self.routes[path] = (200, headers, body)

    def redirect(self, path: str, to: str) -> None:
        self.routes[path] = (302, {"Location": to, "Content-Length": "0"}, b"")

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server():
    s = Server()
    yield s
    s.stop()


@pytest.fixture
def resolve(monkeypatch):
    """Map host -> addresses; each call is recorded. Unknown hosts fail."""
    table: dict[str, list[list[str]]] = {}
    asked: list[str] = []

    def fake(host: str) -> list[str]:
        asked.append(host)
        answers = table.get(host)
        if not answers:
            raise socket.gaierror("no such host")
        return answers.pop(0) if len(answers) > 1 else answers[0]

    monkeypatch.setattr(endpoints, "_resolve", fake)
    fake.table = table  # type: ignore[attr-defined]
    fake.asked = asked  # type: ignore[attr-defined]
    return fake


def refused(url: str, *, public_only: bool = False, max_bytes: int = BIG) -> str:
    with pytest.raises(FetchRefused) as caught:
        fetch_url(url, public_only=public_only, max_bytes=max_bytes)
    return str(caught.value)


# --- what is fetched ----------------------------------------------------------


def test_an_html_page_is_fetched_as_an_html_file(server):
    server.page("/guide", b"<html><body><p>Hi</p></body></html>", "text/html; charset=utf-8")

    data, filename = fetch_url(server.url("/guide"), public_only=False, max_bytes=BIG)

    assert data == b"<html><body><p>Hi</p></body></html>"
    assert filename == "guide.html"


@pytest.mark.parametrize(
    ("path", "content_type", "filename"),
    [
        ("/files/report.pdf", "application/pdf", "report.pdf"),
        ("/download?id=7", "application/pdf", "download.pdf"),
        ("/notes.php", "text/plain", "notes.txt"),
        ("/", "text/html", "page.html"),
        (
            "/memo",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "memo.docx",
        ),
        ("/photo", "image/png", "photo.png"),
        ("/photo.jpeg", "image/jpeg", "photo.jpg"),
        ("/odd%20name!.html", "text/html", "odd_20name_.html"),
    ],
)
def test_the_suffix_follows_the_content_type(server, path, content_type, filename):
    server.page(path, b"body", content_type)

    assert fetch_url(server.url(path), public_only=False, max_bytes=BIG)[1] == filename


def test_the_user_agent_names_pandion_and_its_version(server):
    server.page("/a", b"x", "text/plain")

    fetch_url(server.url("/a"), public_only=False, max_bytes=BIG)

    assert server.agents[0].startswith(f"Pandion/{__version__}")


def test_up_to_three_redirects_are_followed(server):
    server.page("/end", b"done", "text/plain")
    server.redirect("/r3", "/end")
    server.redirect("/r2", server.url("/r3"))
    server.redirect("/r1", "/r2")

    assert fetch_url(server.url("/r1"), public_only=False, max_bytes=BIG) == (b"done", "end.txt")


# --- refusals -----------------------------------------------------------------


def test_more_than_three_redirects_are_refused(server):
    server.page("/end", b"done", "text/plain")
    for n in range(1, 5):
        server.redirect(f"/r{n}", f"/r{n + 1}" if n < 4 else "/end")

    assert refused(server.url("/r1")) == "The URL redirected more than 3 times, so it was not fetched."


def test_a_page_larger_than_the_cap_is_refused(server):
    server.page("/big", b"x" * 2_000, "text/plain")

    assert refused(server.url("/big"), max_bytes=1_000) == (
        "The page is larger than the limit of 1,000 bytes, so it was not fetched."
    )


def test_the_cap_holds_when_the_size_is_not_announced(server):
    server.page("/big", b"x" * 2_000, "text/plain", length=False)

    assert "larger than the limit" in refused(server.url("/big"), max_bytes=1_000)


def test_a_page_exactly_at_the_cap_is_fetched(server):
    server.page("/fits", b"x" * 1_000, "text/plain", length=False)

    assert fetch_url(server.url("/fits"), public_only=False, max_bytes=1_000)[0] == b"x" * 1_000


@pytest.mark.parametrize("content_type", ["application/zip", "application/javascript", ""])
def test_a_type_pandion_does_not_read_is_refused(server, content_type):
    server.page("/thing", b"PK", content_type)

    assert refused(server.url("/thing")) == (
        "Pandion reads HTML, PDF, Word, text, PNG and JPG files from a URL; "
        "this URL sent another kind of file, so it was not fetched."
    )


def test_an_error_status_is_refused(server):
    assert refused(server.url("/missing")) == "The URL answered with status 404, so it was not fetched."


def test_a_slow_page_times_out(server, monkeypatch):
    monkeypatch.setattr(fetch, "TIMEOUT", 0.3)
    server.delay = 1.0
    server.page("/slow", b"x", "text/plain")

    assert refused(server.url("/slow")) == "The URL took longer than 0.3 seconds to answer, so it was not fetched."


def test_the_timeout_is_ten_seconds():
    assert fetch.TIMEOUT == 10


@pytest.mark.parametrize("url", ["ftp://example.com/a", "file:///etc/passwd", "example.com", ""])
def test_only_http_and_https_urls_are_fetched(url):
    assert refused(url) == "A URL document must start with http:// or https://."


def test_a_refusal_never_repeats_the_url(server):
    message = refused(server.url("/missing?token=s3cret"))

    assert "s3cret" not in message and "127.0.0.1" not in message


# --- public_only: the hosted demo's rule --------------------------------------


@pytest.mark.parametrize(
    "url",
    ["http://example.com/page", "https://example.com:8443/page", "https://example.com:80/page"],
)
def test_public_only_takes_https_on_port_443_only(url, resolve):
    resolve.table["example.com"] = [[PUBLIC_V4]]

    assert refused(url, public_only=True) == "Only https addresses on port 443 are fetched here."
    assert resolve.asked == []


@pytest.mark.parametrize(
    "url",
    [
        "https://intranet.example/page",
        "https://localhost/page",
        "https://127.0.0.1/page",
        "https://169.254.169.254/latest/meta-data",
        "https://user@example.com/page",
    ],
)
def test_public_only_refuses_an_address_that_is_not_public(url, resolve):
    resolve.table["intranet.example"] = [[PRIVATE_V4]]

    assert refused(url, public_only=True) == "That address is not on the public internet, so it was not fetched."


def test_public_only_allows_a_query_string(resolve, monkeypatch):
    resolve.table["example.com"] = [[PUBLIC_V4]]
    asked: list[tuple[str, str | None]] = []

    def send(url: str, ip: str | None):
        asked.append((url, ip))
        return FakeResponse(200, {"Content-Type": "text/html"}, b"<p>hi</p>")

    monkeypatch.setattr(fetch, "_send", send)

    data, filename = fetch_url("https://example.com/search?q=ferns#top", public_only=True, max_bytes=BIG)

    assert (data, filename) == (b"<p>hi</p>", "search.html")
    assert asked == [("https://example.com/search?q=ferns", PUBLIC_V4)]


def test_public_only_pins_the_checked_address_so_rebinding_cannot_slip_past(resolve, monkeypatch):
    # The name is public when checked and private on any later lookup.
    resolve.table["rebind.example"] = [[PUBLIC_V4], [PRIVATE_V4]]
    connected: list[tuple[str, int]] = []

    def connect(address, timeout=None, *args, **kwargs):
        connected.append(address)
        raise ConnectionRefusedError("test stops here")

    monkeypatch.setattr(fetch, "_connect", connect)

    assert refused("https://rebind.example/page", public_only=True) == (
        "The URL could not be reached, so it was not fetched."
    )
    assert resolve.asked == ["rebind.example"]
    assert connected == [(PUBLIC_V4, 443)]


def test_public_only_checks_every_redirect_again(resolve, monkeypatch):
    resolve.table["example.com"] = [[PUBLIC_V4]]
    resolve.table["intranet.example"] = [[PRIVATE_V4]]
    sent: list[str] = []

    def send(url: str, ip: str | None):
        sent.append(url)
        return FakeResponse(302, {"Location": "https://intranet.example/admin"}, b"")

    monkeypatch.setattr(fetch, "_send", send)

    assert refused("https://example.com/page", public_only=True) == (
        "That address is not on the public internet, so it was not fetched."
    )
    assert sent == ["https://example.com/page"]


def test_public_only_refuses_a_redirect_to_plain_http(resolve, monkeypatch):
    resolve.table["example.com"] = [[PUBLIC_V4]]
    monkeypatch.setattr(
        fetch, "_send", lambda url, ip: FakeResponse(301, {"Location": "http://example.com/page"}, b"")
    )

    assert refused("https://example.com/page", public_only=True) == (
        "Only https addresses on port 443 are fetched here."
    )


class FakeResponse:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def getheader(self, name: str, default: str | None = None) -> str | None:
        return self.headers.get(name, default)

    def read(self, amount: int = -1) -> bytes:
        out, self.body = (self.body, b"") if amount < 0 else (self.body[:amount], self.body[amount:])
        return out

    def close(self) -> None:
        pass
