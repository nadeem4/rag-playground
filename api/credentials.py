"""Where each provider's API key comes from, and keeping them out of everything else.

One key per provider (I-18):

| provider  | header               | env / `.env`                |
|-----------|----------------------|-----------------------------|
| anthropic | `X-Anthropic-Api-Key`| `ANTHROPIC_API_KEY`         |
| openai    | `X-OpenAI-Api-Key`   | `OPENAI_API_KEY`            |
| custom    | `X-Custom-Api-Key`   | `OPENAI_COMPATIBLE_API_KEY` |

Resolution, per provider, first match wins, once per run request (spec §9):

1. the request header (typed in the UI);
2. the process environment variable;
3. `<repo>/.env`, read with `dotenv_values`. It is **never** loaded into
   `os.environ`, so a key kept there is not inherited by child processes.

In demo mode (`api.demo`) only the header counts, for every provider: the
server has no key of its own, so a public host's key can never be spent by its
visitors.

A key is never stored, echoed, hashed or logged. The API hands the resolved
keys to a run as `context_extras={"credentials": {"<provider>_api_key": key}}`
and holds them only in that run's worker closure. `redact` scrubs them out of
anything the run emits.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from dotenv import dotenv_values

from api import demo

REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class ProviderKey:
    header: str  # the request header the UI sends a typed key in
    env_var: str  # the environment variable, and the `.env` entry
    extra: str  # the key's name in `ctx.extras["credentials"]`


PROVIDERS: dict[str, ProviderKey] = {
    "anthropic": ProviderKey("X-Anthropic-Api-Key", "ANTHROPIC_API_KEY", "anthropic_api_key"),
    "openai": ProviderKey("X-OpenAI-Api-Key", "OPENAI_API_KEY", "openai_api_key"),
    "custom": ProviderKey(
        "X-Custom-Api-Key", "OPENAI_COMPATIBLE_API_KEY", "custom_api_key"
    ),
}

#: The Anthropic header and variable, kept under their original names.
HEADER = PROVIDERS["anthropic"].header
ENV_VAR = PROVIDERS["anthropic"].env_var

#: The `.env` file consulted last. Rebound by tests.
DOTENV_PATH: Path = REPO_ROOT / ".env"

#: What a scrubbed key is replaced with.
REDACTED = "[redacted]"


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def _server_key(provider: str) -> tuple[str | None, str]:
    env_var = PROVIDERS[provider].env_var
    if demo.enabled():
        return None, "none"
    key = _clean(os.environ.get(env_var))
    if key:
        return key, "env"
    if DOTENV_PATH.is_file():
        key = _clean(dotenv_values(DOTENV_PATH).get(env_var))
        if key:
            return key, "dotenv"
    return None, "none"


def resolve_key(header: str | None, provider: str = "anthropic") -> tuple[str | None, str]:
    """(key, source) with source one of "header", "env", "dotenv", "none".

    Raises KeyError for a provider not in `PROVIDERS`.
    """
    PROVIDERS[provider]
    key = _clean(header)
    if key:
        return key, "header"
    return _server_key(provider)


def server_source(provider: str = "anthropic") -> str:
    """Which source the server itself can supply: "env", "dotenv" or "none".
    Always "none" in demo mode: only a key in the request header works."""
    return _server_key(provider)[1]


def resolve_all(headers: dict[str, str | None]) -> dict[str, str]:
    """`ctx.extras["credentials"]` for a request: every key that resolves,
    under its extras name. `headers` maps provider to its header value."""
    out: dict[str, str] = {}
    for provider, spec in PROVIDERS.items():
        key, _ = resolve_key(headers.get(provider), provider)
        if key:
            out[spec.extra] = key
    return out


def redact(value: Any, key: str | Iterable[str] | None) -> Any:
    """Replace every occurrence of `key` (or of each of several keys) in the
    strings inside `value`."""
    keys = [key] if isinstance(key, str) else [k for k in (key or []) if k]
    if not keys:
        return value
    if isinstance(value, str):
        for k in sorted(keys, key=len, reverse=True):
            value = value.replace(k, REDACTED)
        return value
    if isinstance(value, dict):
        return {k: redact(v, keys) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(redact(v, keys) for v in value)
    return value
