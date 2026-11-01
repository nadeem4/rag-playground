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
PUBLIC_V6 = "2606:4700::6812:273"
PRIVATE_V4 = "10.0.0.5"
BIG = 10_000_000


class Server:
    """A local server whose routes map a path to (status, headers, body)."""

    def __init__(self, tls=None) -> None:
        """`tls` is an `ssl.SSLContext` to serve https with."""
        self.routes: dict[str, tuple[int, dict[str, str], bytes]] = {}
        #: Paths answered by a function of the handler, for slow answers.
        self.handlers: dict[str, object] = {}
        self.delay = 0.0
        self.agents: list[str] = []
        routes, server = self.routes, self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_GET(self) -> None:  # noqa: N802
                server.agents.append(self.headers.get("User-Agent", ""))
                if self.path in server.handlers:
                    try:
                        server.handlers[self.path](self)
                    except OSError:
                        pass
                    return
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
        self.scheme = "https" if tls else "http"
        if tls:
            self.httpd.socket = tls.wrap_socket(self.httpd.socket, server_side=True)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path: str) -> str:
        return f"{self.scheme}://127.0.0.1:{self.httpd.server_address[1]}{path}"

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
    assert filename == "127.0.0.1-guide.html"


@pytest.mark.parametrize(
    ("path", "content_type", "filename"),
    [
        ("/files/report.pdf", "application/pdf", "127.0.0.1-files-report.pdf"),
        ("/download?id=7", "application/pdf", "127.0.0.1-download.pdf"),
        ("/notes.php", "text/plain", "127.0.0.1-notes.txt"),
        ("/", "text/html", "127.0.0.1.html"),
        (
            "/memo",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "127.0.0.1-memo.docx",
        ),
        ("/photo", "image/png", "127.0.0.1-photo.png"),
        ("/photo.jpeg", "image/jpeg", "127.0.0.1-photo.jpg"),
        ("/odd%20name!.html", "text/html", "127.0.0.1-odd_20name_.html"),
    ],
)
def test_the_suffix_follows_the_content_type(server, path, content_type, filename):
    server.page(path, b"body", content_type)

    assert fetch_url(server.url(path), public_only=False, max_bytes=BIG)[1] == filename


@pytest.mark.parametrize(
    ("url", "suffix", "filename"),
    [
        (
            "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
            ".html",
            "en.wikipedia.org-wiki-Retrieval-augmented_generation.html",
        ),
        ("https://example.com/", ".html", "example.com.html"),
        ("https://other.example.org", ".html", "other.example.org.html"),
        ("https://example.com/a/b/report.pdf?x=1#top", ".pdf", "example.com-a-b-report.pdf"),
        ("https://Example.COM/docs/", ".html", "example.com-docs.html"),
        ("https://example.com/../../etc/passwd", ".txt", "example.com-etc-passwd.txt"),
    ],
)
def test_a_fetched_page_is_named_from_its_host_and_path(url, suffix, filename):
    assert fetch._filename(url, suffix) == filename


def test_two_front_pages_of_different_sites_get_different_names():
    assert fetch._filename("https://a.example/", ".html") != fetch._filename("https://b.example/", ".html")


def test_a_long_name_is_cut_to_100_characters_before_its_suffix():
    name = fetch._filename("https://example.com/" + "x" * 300, ".html")
    assert name == ("example.com-" + "x" * 300)[:100] + ".html"


def test_the_user_agent_names_pandion_and_its_version(server):
    server.page("/a", b"x", "text/plain")

    fetch_url(server.url("/a"), public_only=False, max_bytes=BIG)

    assert server.agents[0].startswith(f"Pandion/{__version__}")


def test_up_to_three_redirects_are_followed(server):
    server.page("/end", b"done", "text/plain")
    server.redirect("/r3", "/end")
    server.redirect("/r2", server.url("/r3"))
    server.redirect("/r1", "/r2")

    assert fetch_url(server.url("/r1"), public_only=False, max_bytes=BIG) == (b"done", "127.0.0.1-end.txt")


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


def kind_of(url: str, *, public_only: bool = False, max_bytes: int = BIG) -> str:
    with pytest.raises(FetchRefused) as caught:
        fetch_url(url, public_only=public_only, max_bytes=max_bytes)
    return caught.value.kind


def test_every_refusal_says_what_kind_it_is(server, resolve, monkeypatch):
    server.page("/big", b"x" * 2_000, "text/plain")
    server.page("/zip", b"PK", "application/zip")
    for n in range(1, 5):
        server.redirect(f"/r{n}", f"/r{n + 1}")
    resolve.table["intranet.example"] = [[PRIVATE_V4]]

    assert kind_of("ftp://example.com/a") == "bad_url"
    assert kind_of("https://" + "a" * 64 + ".example/page") == "bad_url"
    assert kind_of("http://example.com/a", public_only=True) == "not_https"
    assert kind_of("https://intranet.example/a", public_only=True) == "not_public"
    assert kind_of(server.url("/big"), max_bytes=1_000) == "too_big"
    assert kind_of(server.url("/zip")) == "wrong_type"
    assert kind_of(server.url("/r1")) == "too_many_redirects"
    assert kind_of(server.url("/missing")) == "failed"
    monkeypatch.setattr(fetch, "TIMEOUT", 0.3)
    server.delay = 1.0
    server.page("/slow", b"x", "text/plain")
    assert kind_of(server.url("/slow")) == "timed_out"


def test_the_kinds_are_listed():
    assert set(fetch.KINDS) == {
        "bad_url", "not_https", "not_public", "too_big", "wrong_type", "too_many_redirects", "timed_out", "failed",
    }


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
    asked: list[tuple[str, list[str] | None]] = []

    def send(url: str, ips: list[str] | None, deadline):
        asked.append((url, ips))
        return FakeResponse(200, {"Content-Type": "text/html"}, b"<p>hi</p>")

    monkeypatch.setattr(fetch, "_send", send)

    data, filename = fetch_url("https://example.com/search?q=ferns#top", public_only=True, max_bytes=BIG)

    assert (data, filename) == (b"<p>hi</p>", "example.com-search.html")
    assert asked == [("https://example.com/search?q=ferns", [PUBLIC_V4])]


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

    def send(url: str, ips: list[str] | None, deadline):
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
        fetch, "_send", lambda url, ips, deadline: FakeResponse(301, {"Location": "http://example.com/page"}, b"")
    )

    assert refused("https://example.com/page", public_only=True) == (
        "Only https addresses on port 443 are fetched here."
    )


# --- fixes after review -------------------------------------------------------


def trickle_headers(handler) -> None:
    handler.wfile.write(b"HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n")
    for n in range(60):
        handler.wfile.write(f"X-Slow-{n}: 1\r\n".encode())
        handler.wfile.flush()
        time.sleep(0.1)


def trickle_body(handler) -> None:
    handler.wfile.write(b"HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\n")
    for _ in range(60):
        handler.wfile.write(b"x")
        handler.wfile.flush()
        time.sleep(0.1)


@pytest.mark.parametrize("trickle", [trickle_headers, trickle_body], ids=["headers", "body"])
def test_the_timeout_is_a_deadline_for_the_whole_fetch(server, monkeypatch, trickle):
    # Each byte arrives well inside the socket timeout; only a total deadline stops it.
    monkeypatch.setattr(fetch, "TIMEOUT", 0.6)
    server.handlers["/trickle"] = trickle
    started = time.monotonic()

    assert refused(server.url("/trickle")) == (
        "The URL took longer than 0.6 seconds to answer, so it was not fetched."
    )
    assert time.monotonic() - started < 2.0


def test_check_public_url_allows_an_at_sign_after_the_host(resolve):
    resolve.table["example.com"] = [[PUBLIC_V4]]

    assert endpoints.check_public_url("https://example.com/@user?x=a@b") == [PUBLIC_V4]
    with pytest.raises(endpoints.EndpointRefused):
        endpoints.check_public_url("https://a@example.com/")
    with pytest.raises(endpoints.EndpointRefused):
        endpoints.check_public_endpoint("https://example.com/@user")


@pytest.mark.parametrize("public_only", [False, True])
def test_a_host_name_that_cannot_be_encoded_is_refused_plainly(public_only):
    url = "https://" + "a" * 64 + ".example/page"

    assert refused(url, public_only=public_only) == "The URL's host name is not valid, so it was not fetched."


def test_an_international_host_name_is_sent_in_its_ascii_form(resolve, monkeypatch):
    resolve.table["xn--bcher-kva.example"] = [[PUBLIC_V4]]
    connected: list[tuple[str, int]] = []

    def connect(address, timeout=None, *args, **kwargs):
        connected.append(address)
        raise ConnectionRefusedError("test stops here")

    monkeypatch.setattr(fetch, "_connect", connect)

    assert refused("https://bücher.example/page", public_only=True) == (
        "The URL could not be reached, so it was not fetched."
    )
    assert connected == [(PUBLIC_V4, 443)]


def test_every_checked_address_is_tried_in_turn(resolve, monkeypatch):
    resolve.table["example.com"] = [[PUBLIC_V6, PUBLIC_V4]]
    connected: list[tuple[str, int]] = []

    def connect(address, timeout=None, *args, **kwargs):
        connected.append(address)
        raise OSError("no route")

    monkeypatch.setattr(fetch, "_connect", connect)

    refused("https://example.com/page", public_only=True)

    assert connected == [(PUBLIC_V6, 443), (PUBLIC_V4, 443)]


def test_tls_is_checked_against_the_host_while_connecting_to_the_pinned_address(resolve, monkeypatch):
    import ssl

    resolve.table["example.com"] = [[PUBLIC_V4]]
    connected: list[tuple[str, int]] = []
    hostnames: list[str | None] = []
    raw = socket.socket()

    def connect(address, timeout=None, *args, **kwargs):
        connected.append(address)
        return raw

    class Context:
        def wrap_socket(self, sock, server_hostname=None, **kwargs):
            hostnames.append(server_hostname)
            raise ssl.SSLError("test stops here")

    monkeypatch.setattr(fetch, "_connect", connect)
    monkeypatch.setattr(fetch.ssl, "create_default_context", lambda *a, **k: Context())

    try:
        refused("https://example.com/page", public_only=True)
    finally:
        raw.close()

    assert connected == [(PUBLIC_V4, 443)]
    assert hostnames == ["example.com"]


def test_a_name_with_one_public_and_one_private_address_is_refused(resolve):
    resolve.table["mixed.example"] = [[PUBLIC_V4, PRIVATE_V4]]

    assert refused("https://mixed.example/page", public_only=True) == (
        "That address is not on the public internet, so it was not fetched."
    )


def test_the_deadline_stops_a_trickling_https_server(tmp_path, monkeypatch):
    # The deadline must shut the TLS socket in use, not the raw one it wraps.
    import shutil
    import ssl
    import subprocess

    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("openssl makes the throwaway certificate")
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
         "-keyout", str(key), "-out", str(cert)],
        check=True, capture_output=True,
    )
    served = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    served.load_cert_chain(cert, key)
    trusting = ssl.create_default_context
    monkeypatch.setattr(fetch.ssl, "create_default_context", lambda *a, **k: trusting(cafile=str(cert)))
    monkeypatch.setattr(fetch, "TIMEOUT", 1.0)
    tls = Server(tls=served)
    try:
        tls.page("/ok", b"fine", "text/plain")
        assert fetch_url(tls.url("/ok"), public_only=False, max_bytes=BIG) == (b"fine", "127.0.0.1-ok.txt")

        tls.handlers["/trickle"] = trickle_body
        started = time.monotonic()
        assert refused(tls.url("/trickle")) == (
            "The URL took longer than 1 seconds to answer, so it was not fetched."
        )
        assert time.monotonic() - started < 2.5
    finally:
        tls.stop()


def test_no_checked_addresses_means_no_connection(monkeypatch):
    connected: list = []
    monkeypatch.setattr(fetch, "_connect", lambda *a, **k: connected.append(a))

    with pytest.raises(OSError):
        fetch._open(fetch._PinnedHTTP("example.com", 80, ips=[], deadline=fetch._Deadline(5)), [], fetch._Deadline(5))
    assert connected == []


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


# --- GitHub file links --------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://github.com/o/r/blob/main/docs/a.md", "https://raw.githubusercontent.com/o/r/main/docs/a.md"),
        ("https://github.com/o/r/blob/v1.0/a.md?plain=1#L10", "https://raw.githubusercontent.com/o/r/v1.0/a.md"),
        ("https://www.github.com/o/r/blob/main/a.md", "https://raw.githubusercontent.com/o/r/main/a.md"),
        ("https://github.com/o/r", "https://github.com/o/r"),
        ("https://github.com/o/r/tree/main/docs", "https://github.com/o/r/tree/main/docs"),
        ("https://github.com/o/r/issues/1", "https://github.com/o/r/issues/1"),
        ("https://example.com/o/r/blob/main/a.md", "https://example.com/o/r/blob/main/a.md"),
    ],
)
def test_a_github_file_link_becomes_the_raw_file_link(url, expected):
    assert fetch._raw_github(url) == expected


def test_public_only_checks_the_raw_github_host(resolve):
    resolve.table["raw.githubusercontent.com"] = [[PRIVATE_V4]]

    message = refused("https://github.com/o/r/blob/main/a.md", public_only=True)

    assert message == "That address is not on the public internet, so it was not fetched."
    assert resolve.asked == ["raw.githubusercontent.com"]


def test_a_branch_name_with_slashes_still_gives_the_raw_file_link():
    assert (
        fetch._raw_github("https://github.com/o/r/blob/feature/x/a.md")
        == "https://raw.githubusercontent.com/o/r/feature/x/a.md"
    )


def test_a_redirect_to_a_github_file_link_is_fetched_from_the_raw_host(server, monkeypatch):
    server.redirect("/go", "https://github.com/o/r/blob/main/a.md")
    hosts: list[str] = []

    def connect(address, timeout):
        hosts.append(address[0])
        if address[0] == "127.0.0.1":
            return socket.create_connection(address, timeout)
        raise OSError("no network in tests")

    monkeypatch.setattr(fetch, "_connect", connect)

    assert refused(server.url("/go")) == "The URL could not be reached, so it was not fetched."
    assert hosts[-1] == "raw.githubusercontent.com"
