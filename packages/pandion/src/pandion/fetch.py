"""A URL as a document: fetch one page a user asked for, behind a guard.

`fetch_url(url, public_only=..., max_bytes=...)` returns the page's bytes and a
file name whose suffix follows the content type (`report.pdf`, `guide.html`),
so the formats check reads it right. `IndexPipeline` calls it for every
`http(s)://` item and then stores the bytes like an uploaded file.

Always:

- only `http` and `https`; at most 3 redirects, each one checked again;
- a 10 second timeout; reading stops at `max_bytes + 1` and the page is refused;
- only HTML, PDF, Word, plain text, PNG and JPG content types;
- an honest User-Agent naming Pandion and its version. robots.txt is not read:
  one fetch a user asks for is not crawling, and nothing follows links.

With `public_only` (a pipeline's `models.public_endpoints_only`, for a server
strangers share), every URL, the first and each redirect, must also be https on
port 443 with a host whose every address is public
(`pandion.endpoints.check_public_url`), and the connection goes to the address
that was checked, never to a second DNS answer. That closes the DNS rebinding
gap. Without `public_only` nothing is checked, so a page on your own machine or
network can be indexed.

Each refusal is a `FetchRefused` (a ValueError) with a plain message that never
repeats the URL, so nothing secret in a query string leaks into a log.
"""

from __future__ import annotations

import http.client
import re
import socket
import ssl
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
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")

#: Opens the TCP connection; tests patch it.
_connect = socket.create_connection


class FetchRefused(ValueError):
    """A URL that was not fetched, with a plain reason."""


def is_url(item: object) -> bool:
    """`item` is an `http://` or `https://` string, not a file path."""
    return isinstance(item, str) and item.lower().startswith(("http://", "https://"))


def fetch_url(url: str, *, public_only: bool, max_bytes: int) -> tuple[bytes, str]:
    """The bytes at `url` and a file name for them, or `FetchRefused`."""
    deadline = time.monotonic() + TIMEOUT
    for _ in range(MAX_REDIRECTS + 1):
        url = urldefrag(url or "")[0]
        ip = _check(url, public_only)
        try:
            response = _send(url, ip)
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
                        "this URL sent another kind of file, so it was not fetched."
                    )
                return _read(response, max_bytes, deadline), _filename(url, suffix)
            finally:
                response.close()
        except TimeoutError:
            raise FetchRefused(
                f"The URL took longer than {TIMEOUT:g} seconds to answer, so it was not fetched."
            ) from None
        except (OSError, http.client.HTTPException):
            raise FetchRefused("The URL could not be reached, so it was not fetched.") from None
    raise FetchRefused(f"The URL redirected more than {MAX_REDIRECTS} times, so it was not fetched.")


def _check(url: str, public_only: bool) -> str | None:
    """Refuse `url` if it may not be fetched; the address to connect to when
    `public_only` pins one, else None."""
    try:
        parts = urlsplit(url)
        scheme, host, port = parts.scheme.lower(), parts.hostname, parts.port
    except ValueError:
        raise FetchRefused("A URL document must start with http:// or https://.") from None
    if scheme not in ("http", "https") or not host:
        raise FetchRefused("A URL document must start with http:// or https://.")
    if not public_only:
        return None
    if scheme != "https" or port not in (None, 443):
        raise FetchRefused("Only https addresses on port 443 are fetched here.")
    try:
        return check_public_url(url)
    except EndpointRefused:
        raise FetchRefused(
            "That address is not on the public internet, so it was not fetched."
        ) from None


def _user_agent() -> str:
    from pandion import __version__

    return f"Pandion/{__version__} (+https://github.com/nadeem4/rag-playground)"


def _send(url: str, ip: str | None) -> http.client.HTTPResponse:
    """GET `url`, connecting to `ip` when given, and return the response."""
    parts = urlsplit(url)
    if parts.scheme.lower() == "https":
        conn: http.client.HTTPConnection = _PinnedHTTPS(parts.hostname, parts.port, ip=ip)
    else:
        conn = _PinnedHTTP(parts.hostname, parts.port, ip=ip)
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    conn.request("GET", path, headers={"User-Agent": _user_agent(), "Connection": "close"})
    return conn.getresponse()


class _PinnedHTTP(http.client.HTTPConnection):
    """Connects to `ip` when given, never to a fresh DNS answer for the host."""

    def __init__(self, host: str | None, port: int | None, *, ip: str | None) -> None:
        super().__init__(host or "", port, timeout=TIMEOUT)
        self.ip = ip

    def connect(self) -> None:
        self.sock = _connect((self.ip or self.host, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    """As `_PinnedHTTP`, with TLS checked against the host name."""

    def __init__(self, host: str | None, port: int | None, *, ip: str | None) -> None:
        super().__init__(host or "", port, timeout=TIMEOUT, context=ssl.create_default_context())
        self.ip = ip

    def connect(self) -> None:
        sock = _connect((self.ip or self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _read(response: http.client.HTTPResponse, max_bytes: int, deadline: float) -> bytes:
    """The body, refused once it passes `max_bytes` or the deadline."""
    too_big = FetchRefused(
        f"The page is larger than the limit of {max_bytes:,} bytes, so it was not fetched."
    )
    announced = response.getheader("Content-Length")
    if announced and announced.isdigit() and int(announced) > max_bytes:
        raise too_big
    parts: list[bytes] = []
    size = 0
    while size <= max_bytes:
        if time.monotonic() > deadline:
            raise TimeoutError
        chunk = response.read(min(_CHUNK, max_bytes + 1 - size))
        if not chunk:
            return b"".join(parts)
        parts.append(chunk)
        size += len(chunk)
    raise too_big


def _filename(url: str, suffix: str) -> str:
    """The last part of the URL's path, made safe, with `suffix`: `report.pdf`,
    or `page.html` for a site's front page."""
    stem = _UNSAFE.sub("_", PurePosixPath(urlsplit(url).path).stem)[:100]
    return f"{stem or 'page'}{suffix}"
