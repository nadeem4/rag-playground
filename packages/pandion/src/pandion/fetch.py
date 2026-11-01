"""A URL as a document: fetch one page a user asked for, behind a guard.

`fetch_url(url, public_only=..., max_bytes=...)` returns the page's bytes and a
file name whose suffix follows the content type (`report.pdf`, `guide.html`),
so the formats check reads it right. `IndexPipeline` calls it for every
`http(s)://` item and then stores the bytes like an uploaded file.

Always:

- only `http` and `https`; at most 3 redirects, each one checked again;
- a 10 second deadline for the whole fetch, redirects, headers and body
  included: a timer shuts the socket when it passes, so a server that sends
  one byte at a time cannot hold the fetch open;
- reading stops at `max_bytes + 1` and the page is refused;
- only HTML, PDF, Word, plain text, PNG and JPG content types;
- the host name is sent in its IDNA (ASCII) form; one that has none is refused;
- an honest User-Agent naming Pandion and its version. robots.txt is not read:
  one fetch a user asks for is not crawling, and nothing follows links.

With `public_only` (a pipeline's `models.public_endpoints_only`, for a server
strangers share), every URL, the first and each redirect, must also be https on
port 443 with a host whose every address is public
(`pandion.endpoints.check_public_url`), and the connection goes only to the
addresses that were checked, tried in turn, never to a second DNS answer. That
closes the DNS rebinding gap. TLS is still checked against the host name.
Without `public_only` nothing is checked, so a page on your own machine or
network can be indexed.

Each refusal is a `FetchRefused` (a ValueError) with a plain message that never
repeats the URL, so nothing secret in a query string leaks into a log, and a
`kind` (one of `KINDS`) a server can map to a status without reading the
message.

A GitHub file link (`github.com/<owner>/<repo>/blob/<ref>/<path>`) is rewritten to
the file on raw.githubusercontent.com before the checks and before each redirect,
so the file is indexed and not the HTML page around it. Raw GitHub answers
`text/plain`, so the file is stored as `.txt`.

A fetched page is named from its host and path, such as
`en.wikipedia.org-wiki-Retrieval-augmented_generation.html`, so the front
pages of two sites never share a name.
"""

from __future__ import annotations

import http.client
import re
import socket
import ssl
import threading
import time
from pathlib import PurePosixPath
from urllib.parse import urldefrag, urljoin, urlsplit

from pandion.endpoints import EndpointRefused, check_public_url

#: Seconds before a fetch gives up, for the whole fetch with its redirects.
TIMEOUT = 10
#: Redirects followed before a fetch is refused.
MAX_REDIRECTS = 3
#: The content types a URL may send, and the suffix each one's file gets.
CONTENT_TYPES: dict[str, str] = {
    "text/html": ".html",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "text/plain": ".txt",
    "image/png": ".png",
    "image/jpeg": ".jpg",
}

_REDIRECTS = {301, 302, 303, 307, 308}
_CHUNK = 64 * 1024
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
#: The longest name a fetched page gets, before its suffix.
MAX_NAME = 100

#: What each `FetchRefused.kind` means.
KINDS: dict[str, str] = {
    "bad_url": "not an http or https URL, or its host name is not valid",
    "not_https": "with public_only, not https on port 443",
    "not_public": "with public_only, an address not on the public internet",
    "too_big": "the page is larger than max_bytes",
    "wrong_type": "the page sent a content type Pandion does not read",
    "too_many_redirects": "more than MAX_REDIRECTS redirects",
    "timed_out": "the fetch took longer than TIMEOUT",
    "failed": "the page answered with an error status, or could not be reached",
}

#: Opens the TCP connection; tests patch it.
_connect = socket.create_connection


class FetchRefused(ValueError):
    """A URL that was not fetched, with a plain reason and its `kind` (see KINDS)."""

    def __init__(self, message: str, kind: str = "failed") -> None:
        super().__init__(message)
        self.kind = kind


def is_url(item: object) -> bool:
    """`item` is an `http://` or `https://` string, not a file path."""
    return isinstance(item, str) and item.lower().startswith(("http://", "https://"))


class _Deadline:
    """The fetch's one deadline. `arm(sock)` starts a timer that shuts the
    socket in use down when the deadline passes, which ends any read blocked
    on it. After TLS wraps the socket, `retarget` points the timer at the
    wrapped one: wrapping detaches the raw socket, so shutting that would do
    nothing."""

    def __init__(self, seconds: float) -> None:
        self.end = time.monotonic() + seconds
        self.expired = False
        self.target: socket.socket | None = None
        self._timers: list[threading.Timer] = []

    def remaining(self) -> float:
        left = self.end - time.monotonic()
        if left <= 0:
            self.expired = True
            raise TimeoutError
        return left

    def arm(self, sock: socket.socket) -> None:
        self.target = sock

        def shut() -> None:
            self.expired = True
            try:
                if self.target is not None:
                    self.target.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        timer = threading.Timer(self.remaining(), shut)
        timer.daemon = True
        timer.start()
        self._timers.append(timer)

    def retarget(self, sock: socket.socket) -> None:
        """Shut `sock` instead when the deadline passes."""
        self.target = sock
        if self.expired:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def cancel(self) -> None:
        for timer in self._timers:
            timer.cancel()


def fetch_url(url: str, *, public_only: bool, max_bytes: int) -> tuple[bytes, str]:
    """The bytes at `url` and a file name for them, or `FetchRefused`."""
    deadline = _Deadline(TIMEOUT)
    try:
        return _fetch(url, public_only, max_bytes, deadline)
    finally:
        deadline.cancel()


def _fetch(url: str, public_only: bool, max_bytes: int, deadline: _Deadline) -> tuple[bytes, str]:
    timed_out = FetchRefused(
        f"The URL took longer than {TIMEOUT:g} seconds to answer, so it was not fetched.", "timed_out"
    )
    for _ in range(MAX_REDIRECTS + 1):
        url = _raw_github(urldefrag(url or "")[0])
        ips = _check(url, public_only)
        try:
            response = _send(url, ips, deadline)
            try:
                if response.status in _REDIRECTS and response.getheader("Location"):
                    url = urljoin(url, response.getheader("Location"))
                    continue
                if not 200 <= response.status < 300:
                    raise FetchRefused(
                        f"The URL answered with status {response.status}, so it was not fetched."
                    )
                suffix = CONTENT_TYPES.get(
                    (response.getheader("Content-Type") or "").split(";")[0].strip().lower()
                )
                if suffix is None:
                    raise FetchRefused(
                        "Pandion reads HTML, PDF, Word, text, PNG and JPG files from a URL; "
                        "this URL sent another kind of file, so it was not fetched.",
                        "wrong_type",
                    )
                data = _read(response, max_bytes, deadline)
                if deadline.expired:
                    raise timed_out
                return data, _filename(url, suffix)
            finally:
                response.close()
        except TimeoutError:
            raise timed_out from None
        except (OSError, http.client.HTTPException):
            if deadline.expired:
                raise timed_out from None
            raise FetchRefused("The URL could not be reached, so it was not fetched.") from None
    raise FetchRefused(
        f"The URL redirected more than {MAX_REDIRECTS} times, so it was not fetched.", "too_many_redirects"
    )


def _raw_github(url: str) -> str:
    """A GitHub file link (`github.com/<owner>/<repo>/blob/<ref>/<path>`) as the
    file itself on raw.githubusercontent.com, so the file is fetched and not the
    GitHub web page around it. The query is dropped. Any other URL is returned
    unchanged."""
    parts = urlsplit(url)
    if parts.scheme.lower() in ("http", "https") and (parts.hostname or "").lower() in ("github.com", "www.github.com"):
        match = re.fullmatch(r"/([^/]+)/([^/]+)/blob/([^/]+)/(.+)", parts.path)
        if match:
            return "https://raw.githubusercontent.com/" + "/".join(match.groups())
    return url


def _ascii(host: str) -> str:
    """`host` in its IDNA (ASCII) form, or `FetchRefused`."""
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError:
        raise FetchRefused("The URL's host name is not valid, so it was not fetched.", "bad_url") from None


def _check(url: str, public_only: bool) -> list[str] | None:
    """Refuse `url` if it may not be fetched; the addresses to connect to when
    `public_only` pins them, else None."""
    try:
        parts = urlsplit(url)
        scheme, host, port = parts.scheme.lower(), parts.hostname, parts.port
    except ValueError:
        raise FetchRefused("A URL document must start with http:// or https://.", "bad_url") from None
    if scheme not in ("http", "https") or not host:
        raise FetchRefused("A URL document must start with http:// or https://.", "bad_url")
    if public_only and (scheme != "https" or port not in (None, 443)):
        raise FetchRefused("Only https addresses on port 443 are fetched here.", "not_https")
    _ascii(host)
    if not public_only:
        return None
    try:
        return check_public_url(url)
    except EndpointRefused:
        raise FetchRefused(
            "That address is not on the public internet, so it was not fetched.", "not_public"
        ) from None


def _user_agent() -> str:
    from pandion import __version__

    return f"Pandion/{__version__} (+https://github.com/nadeem4/rag-playground)"


def _send(url: str, ips: list[str] | None, deadline: _Deadline) -> http.client.HTTPResponse:
    """GET `url`, connecting only to `ips` when given, and return the response."""
    parts = urlsplit(url)
    host = _ascii(parts.hostname or "")
    if parts.scheme.lower() == "https":
        conn: http.client.HTTPConnection = _PinnedHTTPS(host, parts.port, ips=ips, deadline=deadline)
    else:
        conn = _PinnedHTTP(host, parts.port, ips=ips, deadline=deadline)
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    conn.request("GET", path, headers={"User-Agent": _user_agent(), "Connection": "close"})
    return conn.getresponse()


def _open(conn: http.client.HTTPConnection, ips: list[str] | None, deadline: _Deadline) -> socket.socket:
    """A socket to the first of `ips` that answers (or to the host when there
    are none), with the deadline armed on it."""
    error: OSError | None = None
    for address in [conn.host] if ips is None else ips:
        try:
            sock = _connect((address, conn.port), min(TIMEOUT, deadline.remaining()))
        except TimeoutError:
            raise
        except OSError as caught:
            error = caught
            continue
        deadline.arm(sock)
        return sock
    raise error or OSError("no address")


class _PinnedHTTP(http.client.HTTPConnection):
    """Connects only to `ips` when given, never to a fresh DNS answer."""

    def __init__(self, host: str, port: int | None, *, ips: list[str] | None, deadline: _Deadline) -> None:
        super().__init__(host, port, timeout=TIMEOUT)
        self.ips, self.deadline = ips, deadline

    def connect(self) -> None:
        self.sock = _open(self, self.ips, self.deadline)


class _PinnedHTTPS(http.client.HTTPSConnection):
    """As `_PinnedHTTP`, with TLS checked against the host name."""

    def __init__(self, host: str, port: int | None, *, ips: list[str] | None, deadline: _Deadline) -> None:
        super().__init__(host, port, timeout=TIMEOUT, context=ssl.create_default_context())
        self.ips, self.deadline = ips, deadline

    def connect(self) -> None:
        # The timer is armed on the raw socket, so it covers the handshake.
        sock = _open(self, self.ips, self.deadline)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        self.deadline.retarget(self.sock)


def _read(response: http.client.HTTPResponse, max_bytes: int, deadline: _Deadline) -> bytes:
    """The body, refused once it passes `max_bytes` or the deadline."""
    too_big = FetchRefused(
        f"The page is larger than the limit of {max_bytes:,} bytes, so it was not fetched.", "too_big"
    )
    announced = response.getheader("Content-Length")
    if announced and announced.isdigit() and int(announced) > max_bytes:
        raise too_big
    parts: list[bytes] = []
    size = 0
    while size <= max_bytes:
        deadline.remaining()
        chunk = response.read(min(_CHUNK, max_bytes + 1 - size))
        if not chunk:
            return b"".join(parts)
        parts.append(chunk)
        size += len(chunk)
    raise too_big


def _filename(url: str, suffix: str) -> str:
    """The URL's host and path, made safe and joined with `-`, at most MAX_NAME
    characters, with `suffix`: `example.com-files-report.pdf`, or
    `example.com.html` for a site's front page. The path's own extension is
    dropped (the suffix follows the content type), and so are `.` and `..`."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    path = PurePosixPath(parts.path or "/")
    segments = [s for s in path.parent.parts if s not in ("/", ".", "..")]
    if path.name not in ("", ".", ".."):
        segments.append(path.stem)
    stem = "-".join(_UNSAFE.sub("_", part) for part in [host, *segments] if part)[:MAX_NAME]
    return f"{stem or 'page'}{suffix}"
