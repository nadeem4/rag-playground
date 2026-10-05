"""On the demo, a custom endpoint must be a public https address.

`check_public_endpoint` is the one check; `guard_endpoint` runs it only in demo
mode. The resolver is always mocked: no test here touches DNS.
"""

from __future__ import annotations

import socket

import pytest

from providers import endpoints
from providers.endpoints import (
    DEMO_ENDPOINT_ERROR,
    EndpointRefused,
    check_public_endpoint,
    guard_endpoint,
)

PUBLIC_V4 = "104.18.2.115"
PUBLIC_V6 = "2606:4700::6812:273"


@pytest.fixture
def resolve(monkeypatch):
    """Map host -> addresses. Unknown hosts fail to resolve."""
    table: dict[str, list[str]] = {}
    asked: list[str] = []

    def fake(host: str) -> list[str]:
        asked.append(host)
        if host not in table:
            raise socket.gaierror("no such host")
        return table[host]

    monkeypatch.setattr(endpoints, "_resolve", fake)
    fake.table = table  # type: ignore[attr-defined]
    fake.asked = asked  # type: ignore[attr-defined]
    return fake


def refused(url: str) -> str:
    with pytest.raises(EndpointRefused) as info:
        check_public_endpoint(url)
    return str(info.value)


# --- accepted -----------------------------------------------------------------


def test_a_public_https_name_is_accepted(resolve):
    resolve.table["api.example.com"] = [PUBLIC_V4, PUBLIC_V6]
    check_public_endpoint("https://api.example.com/v1")
    assert resolve.asked == ["api.example.com"]


def test_an_explicit_443_is_accepted(resolve):
    resolve.table["api.example.com"] = [PUBLIC_V4]
    check_public_endpoint("https://api.example.com:443/v1")


def test_the_error_is_the_plain_words_message(resolve):
    assert refused("http://api.example.com/v1") == DEMO_ENDPOINT_ERROR
    assert DEMO_ENDPOINT_ERROR == (
        "On the demo, a custom endpoint must be a public https address. "
        "Run the playground locally to use a server on your own machine."
    )


# --- the URL itself -----------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://api.example.com/v1",
        "ftp://api.example.com/",
        "file:///etc/passwd",
        "api.example.com/v1",
        "//api.example.com/v1",
        "",
        "https://",
        "https:///v1",
    ],
)
def test_only_https_with_a_host_is_accepted(resolve, url):
    resolve.table["api.example.com"] = [PUBLIC_V4]
    refused(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://user:pass@api.example.com/v1",
        "https://user@api.example.com/v1",
        "https://:pass@api.example.com/v1",
    ],
)
def test_credentials_in_the_url_are_refused(resolve, url):
    resolve.table["api.example.com"] = [PUBLIC_V4]
    refused(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com:8443/v1",
        "https://api.example.com:80/v1",
        "https://api.example.com:0/v1",
        "https://api.example.com:99999/v1",
        "https://api.example.com:abc/v1",
    ],
)
def test_any_port_other_than_443_is_refused(resolve, url):
    resolve.table["api.example.com"] = [PUBLIC_V4]
    refused(url)


@pytest.mark.parametrize(
    "url",
    ["https://localhost/v1", "https://LOCALHOST./v1", "https://ollama.localhost/v1"],
)
def test_localhost_is_refused_without_asking_dns(resolve, url):
    refused(url)
    assert resolve.asked == []


def test_a_name_that_does_not_resolve_is_refused(resolve):
    refused("https://nowhere.example/v1")


@pytest.fixture
def answers_public(monkeypatch):
    """A resolver that says every name is public, so only the URL rules can refuse."""
    asked: list[str] = []

    def fake(host: str) -> list[str]:
        asked.append(host)
        return [PUBLIC_V4]

    monkeypatch.setattr(endpoints, "_resolve", fake)
    return asked


@pytest.mark.parametrize(
    "url",
    [
        "https://2130706433/v1",  # decimal 127.0.0.1
        "https://017700000001/v1",  # octal
        "https://0177.0.0.1/v1",  # octal octet
        "https://0x7f000001/v1",  # hex
        "https://0x7f.0.0.1/v1",
        "https://127.1/v1",  # short form
        "https://１２７.０.０.１/v1",  # fullwidth 127.0.0.1
        "https://ｌｏｃａｌｈｏｓｔ/v1",  # fullwidth localhost
    ],
)
def test_numeric_and_fullwidth_hosts_are_refused_without_dns(answers_public, url):
    refused(url)
    assert answers_public == []


def test_an_idna_host_is_resolved_in_its_ascii_form(answers_public):
    check_public_endpoint("https://bücher.example/v1")
    assert answers_public == ["xn--bcher-kva.example"]


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com#@127.0.0.1/v1",
        "https://api.example.com?@127.0.0.1/v1",
        "https://api.example.com/v1#frag",
        "https://api.example.com/v1?x=1",
        "https://api.example.com\\@127.0.0.1/v1",
        "https://api.example.com/v1/@127.0.0.1",
        "https://api.example .com/v1",
        "https://api.example.com/v1\n",
    ],
)
def test_tricks_with_at_signs_queries_and_odd_characters_are_refused(answers_public, url):
    refused(url)


def test_a_dns_name_pointed_at_loopback_is_refused(resolve):
    resolve.table["loop.attacker.example"] = ["127.0.0.1", "::1"]
    refused("https://loop.attacker.example/v1")
    assert resolve.asked == ["loop.attacker.example"]


# --- the addresses ------------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",  # loopback
        "127.8.9.10",
        "10.0.0.5",  # private
        "172.16.3.4",
        "192.168.1.1",
        "169.254.169.254",  # link-local, cloud metadata
        "100.64.0.1",  # CGNAT
        "100.127.255.254",
        "224.0.0.1",  # multicast
        "239.255.255.250",
        "240.0.0.1",  # reserved
        "255.255.255.255",
        "0.0.0.0",  # unspecified
        "198.18.0.1",  # benchmarking
        "192.0.0.1",
        "::1",  # IPv6 loopback
        "::",  # IPv6 unspecified
        "fe80::1",  # IPv6 link-local
        "fc00::1",  # IPv6 unique local
        "fd12:3456::1",
        "fec0::1",  # IPv6 site-local
        "ff02::1",  # IPv6 multicast
        "ff0e::1",
        "::ffff:127.0.0.1",  # IPv4-mapped
        "::ffff:169.254.169.254",
        "::ffff:10.0.0.1",
        "::127.0.0.1",  # IPv4-compatible
        "2002:7f00:1::1",  # 6to4 around 127.0.0.1
        "2002:a9fe:a9fe::1",  # 6to4 around 169.254.169.254
        "64:ff9b::a9fe:a9fe",  # NAT64 around 169.254.169.254
    ],
)
def test_a_non_public_address_literal_is_refused(resolve, address):
    resolve.table[address] = [address]
    host = f"[{address}]" if ":" in address else address
    refused(f"https://{host}/v1")


def test_a_public_address_literal_is_accepted(resolve):
    resolve.table[PUBLIC_V4] = [PUBLIC_V4]
    resolve.table[PUBLIC_V6] = [PUBLIC_V6]
    check_public_endpoint(f"https://{PUBLIC_V4}/v1")
    check_public_endpoint(f"https://[{PUBLIC_V6}]/v1")


def test_a_name_that_resolves_to_loopback_is_refused(resolve):
    resolve.table["sneaky.example.com"] = ["127.0.0.1"]
    refused("https://sneaky.example.com/v1")


def test_every_resolved_address_is_checked(resolve):
    resolve.table["mixed.example.com"] = [PUBLIC_V4, PUBLIC_V6, "10.1.2.3"]
    refused("https://mixed.example.com/v1")


def test_a_name_that_resolves_to_a_mapped_metadata_address_is_refused(resolve):
    resolve.table["meta.example.com"] = ["::ffff:169.254.169.254"]
    refused("https://meta.example.com/v1")


def test_the_real_resolver_returns_bare_addresses(monkeypatch):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        assert (host, port) == ("api.example.com", 443)
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("104.18.2.115", 443)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700::1", 443, 0, 0)),
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    assert endpoints._resolve("api.example.com") == ["104.18.2.115", "2606:4700::1"]


# --- demo mode only -----------------------------------------------------------


def test_guard_does_nothing_outside_demo_mode(resolve, monkeypatch):
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO", raising=False)
    guard_endpoint("http://localhost:11434/v1")
    assert resolve.asked == []


def test_guard_checks_in_demo_mode(resolve, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    with pytest.raises(EndpointRefused):
        guard_endpoint("http://localhost:11434/v1")
    resolve.table["api.example.com"] = [PUBLIC_V4]
    guard_endpoint("https://api.example.com/v1")


def test_the_demo_switch_is_the_same_one_the_api_reads():
    from api import demo

    assert endpoints.DEMO_ENV_VAR == demo.ENV_VAR
