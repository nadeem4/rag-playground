"""Where the Anthropic API key comes from, and keeping it out of everything else.

Resolution, first match wins, once per run request (spec §9):

1. the `X-Anthropic-Api-Key` request header (typed in the UI);
2. the process environment variable `ANTHROPIC_API_KEY`;
3. `<repo>/.env`, read with `dotenv_values`. It is **never** loaded into
   `os.environ`, so a key kept there is not inherited by child processes.

The key is never stored, echoed, hashed or logged. The API hands it to a run as
`context_extras={"credentials": {"anthropic_api_key": key}}` and holds it only
in that run's worker closure. `redact` scrubs it out of anything the run emits.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from dotenv import dotenv_values

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The request header the UI sends a typed key in.
HEADER = "X-Anthropic-Api-Key"

#: The environment variable, and the `.env` entry, the server reads.
ENV_VAR = "ANTHROPIC_API_KEY"

#: The `.env` file consulted last. Rebound by tests.
DOTENV_PATH: Path = REPO_ROOT / ".env"

#: What a scrubbed key is replaced with.
REDACTED = "[redacted]"


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def _server_key() -> tuple[str | None, str]:
    key = _clean(os.environ.get(ENV_VAR))
    if key:
        return key, "env"
    if DOTENV_PATH.is_file():
        key = _clean(dotenv_values(DOTENV_PATH).get(ENV_VAR))
        if key:
            return key, "dotenv"
    return None, "none"


def resolve_key(header: str | None) -> tuple[str | None, str]:
    """(key, source) with source one of "header", "env", "dotenv", "none"."""
    key = _clean(header)
    if key:
        return key, "header"
    return _server_key()


def server_source() -> str:
    """Which source the server itself can supply: "env", "dotenv" or "none"."""
    return _server_key()[1]


def redact(value: Any, key: str | None) -> Any:
    """Replace every occurrence of `key` in the strings inside `value`."""
    if not key:
        return value
    if isinstance(value, str):
        return value.replace(key, REDACTED)
    if isinstance(value, dict):
        return {k: redact(v, key) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(redact(v, key) for v in value)
    return value
