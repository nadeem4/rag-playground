"""Model keys: which header and variable each provider's key comes in, and
keeping keys out of everything a run shows.

A key is never stored, echoed, hashed or logged. A run gets the keys
`Policy.credentials(request)` resolves, holds them only in its worker's
closure, and every event and result it gives passes through `redact`.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass
from typing import Any, Callable, Iterable


@dataclass(frozen=True)
class ProviderKey:
    header: str  # the request header a client sends a key in
    env_var: str  # the server's environment variable
    extra: str  # the key's name in Pandion's `credentials=`


PROVIDERS: dict[str, ProviderKey] = {
    "anthropic": ProviderKey("X-Anthropic-Api-Key", "ANTHROPIC_API_KEY", "anthropic_api_key"),
    "openai": ProviderKey("X-OpenAI-Api-Key", "OPENAI_API_KEY", "openai_api_key"),
    "custom": ProviderKey("X-Custom-Api-Key", "OPENAI_COMPATIBLE_API_KEY", "custom_api_key"),
    "openrouter": ProviderKey("X-OpenRouter-Api-Key", "OPENROUTER_API_KEY", "openrouter_api_key"),
}

#: What a scrubbed key is replaced with.
REDACTED = "[redacted]"


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


def guarded(keys: list[str], fn: Callable[[], Any]) -> Any:
    """Run `fn`; a crash is raised again with every key scrubbed from its traceback."""
    try:
        return fn()
    except Exception:
        if not keys:
            raise
        raise RuntimeError(redact(traceback.format_exc(), keys)) from None
