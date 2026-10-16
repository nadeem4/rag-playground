"""When strangers share a server, a custom endpoint must be a public https address.

A custom `base_url` makes the server send a request to a URL someone else
chose. On a shared host (such as the RAG Playground's hosted demo) that could
reach the host's own services (localhost, private ranges, cloud metadata at
169.254.169.254), so `guard_endpoint(url, public_only=True)` refuses every
`base_url` that is not a public https address before any client is built.
With `public_only=False` it does nothing, so Ollama and LM Studio on localhost
keep working.

The package never decides on its own whether it serves strangers: the caller
passes `public_only`, and a run hands it to its steps as
`context_extras={"public_endpoints_only": True}`. The app turns it on for its
hosted demo.

`check_public_endpoint` accepts only:

- the `https` scheme, no user name or password in the URL, port 443 or none;
- no `@`, query, fragment, backslash, space or control character anywhere;
- a host that is not a decimal, octal or hex IPv4 form, judged in its IDNA
  (ASCII) form, so a fullwidth `localhost` is still `localhost`;
- a host name other than `localhost` (or `*.localhost`) that resolves, where
  **every** resolved address is public: not loopback, private, link-local,
  CGNAT, multicast, reserved or unspecified. IPv6 addresses that carry an IPv4
  address (IPv4-mapped, 6to4, Teredo, NAT64) are judged by that IPv4 address
  too.

The client also stops following redirects when `public_only` is on
(`pandion.llm.openai_client_kwargs`), so a public endpoint cannot bounce the
request to a private one.

What this does not stop: the SDK resolves the name again when it connects, so a
name whose DNS answer changes between the check and the request (DNS
rebinding) can still slip past. `check_public_url` is the same check with a
query string allowed; it returns the checked address, and `pandion.fetch`
connects to that address only, so a fetched URL has no such gap. The playground refuses custom endpoints on its
demo outright (`playground.backend.policy.PlaygroundPolicy`); this check is the second line
behind that.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit

DEMO_ENDPOINT_ERROR = (
    "On the demo, a custom endpoint must be a public https address. "
    "Run the playground locally to use a server on your own machine."
)

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

_NAT64 = ipaddress.ip_network("64:ff9b::/96")

#: Whitespace, control characters and backslashes, which parsers disagree on.
_ODD = re.compile(r"[\s\\\x00-\x1f\x7f]")


class EndpointRefused(ValueError):
    """A custom endpoint the demo will not call."""

    def __init__(self) -> None:
        super().__init__(DEMO_ENDPOINT_ERROR)


def _resolve(host: str) -> list[str]:
    """Every address `host` resolves to. Tests patch this."""
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


def _embedded_v4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if ip.ipv4_mapped:
        return ip.ipv4_mapped
    if ip.sixtofour:
        return ip.sixtofour
    if ip.teredo:
        return ip.teredo[1]
    if ip in _NAT64:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def _is_public(ip: IPAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        inner = _embedded_v4(ip)
        if inner is not None and not _is_public(inner):
            return False
        if ip.is_site_local:
            return False
    return ip.is_global and not (ip.is_multicast or ip.is_reserved)


def _ascii_host(host: str) -> str:
    """The host as the network sees it: IDNA-encoded, so a fullwidth or other
    look-alike form is judged by the ASCII name it turns into."""
    if host.isascii():
        return host
    return host.encode("idna").decode("ascii").lower()


def _legacy_ipv4(host: str) -> bool:
    """A decimal, octal, hex or short IPv4 form (`2130706433`, `0177.0.0.1`,
    `0x7f000001`, `127.1`), which resolvers accept but `ipaddress` does not."""
    try:
        socket.inet_aton(host)
    except (OSError, ValueError):
        return False
    return True


def check_public_endpoint(url: str) -> None:
    """Raise `EndpointRefused` unless `url` is a public https address."""
    # A base URL needs no query.
    if "?" in (url or ""):
        raise EndpointRefused()
    check_public_url(url)


def check_public_url(url: str) -> str:
    """Raise `EndpointRefused` unless `url` is a public https address; a query
    string is allowed. Returns the checked address, so a caller can connect to
    that address and no other (`pandion.fetch` does, which closes the DNS
    rebinding gap for it)."""
    url = url or ""
    # No `@` anywhere (credentials, or `#@` and `?@` tricks), no fragment, no
    # backslash, space or control character.
    if "@" in url or "#" in url or _ODD.search(url):
        raise EndpointRefused()
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise EndpointRefused() from None
    if parts.scheme.lower() != "https":
        raise EndpointRefused()
    if parts.username is not None or parts.password is not None:
        raise EndpointRefused()
    if port not in (None, 443):
        raise EndpointRefused()
    try:
        host = _ascii_host((parts.hostname or "").rstrip(".").lower()).rstrip(".")
    except UnicodeError:
        raise EndpointRefused() from None
    if not host or host == "localhost" or host.endswith(".localhost"):
        raise EndpointRefused()
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not _is_public(literal):
            raise EndpointRefused()
        return str(literal)
    if _legacy_ipv4(host):
        raise EndpointRefused()
    try:
        addresses = _resolve(host)
    except (OSError, UnicodeError):
        raise EndpointRefused() from None
    if not addresses:
        raise EndpointRefused()
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address.split("%", 1)[0])
        except ValueError:
            raise EndpointRefused() from None
        if not _is_public(ip):
            raise EndpointRefused()
    return addresses[0].split("%", 1)[0]


#: The run extra that turns the check on. Never hashed or stored.
PUBLIC_ONLY_EXTRA = "public_endpoints_only"


def guard_endpoint(url: str, *, public_only: bool) -> None:
    """`check_public_endpoint` when `public_only` is on; nothing otherwise.

    `public_only` has no default, so no caller can forget to decide.
    """
    if public_only:
        check_public_endpoint(url)
