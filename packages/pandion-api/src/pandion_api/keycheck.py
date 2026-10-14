"""Does a model key work? One call that costs no tokens: `models.list()`, or for
OpenRouter, whose model list is public, `GET /key`, which needs a valid key.
`POST /settings/models/check` calls it."""

from __future__ import annotations

from typing import Any

from pandion.extend import EndpointRefused, guard_endpoint, openai_client_kwargs
from pandion_api.credentials import redact

NO_BASE_URL = "no base URL: send the custom endpoint's base URL to check it"
REJECTED = "authentication failed: the API key was rejected"


def check_key(
    provider: str,
    key: str | None,
    source: str,
    *,
    base_url: str | None,
    public_only: bool,
    missing: str,
) -> dict[str, Any]:
    """`{"ok", "source", "error"}`. Never returns or logs the key. A custom
    endpoint needs `base_url`, which must pass `guard_endpoint`; any other
    provider needs a key, else the error is `missing`."""
    if provider == "custom":
        if not base_url:
            return {"ok": False, "source": source, "error": NO_BASE_URL}
        try:
            guard_endpoint(base_url, public_only=public_only)
        except EndpointRefused as exc:
            return {"ok": False, "source": source, "error": str(exc)}
    elif not key:
        return {"ok": False, "source": source, "error": missing}

    auth_error: Any = ()
    try:
        if provider == "anthropic":
            import anthropic  # deferred: only the check needs the SDKs

            auth_error = anthropic.AuthenticationError
            client = anthropic.Anthropic(api_key=key, max_retries=0, timeout=15.0)
        else:
            import openai

            auth_error = openai.AuthenticationError
            kwargs: dict[str, Any] = {
                **openai_client_kwargs(
                    key,
                    base_url if provider == "custom" else None,
                    openrouter=provider == "openrouter",
                    public_only=public_only,
                ),
                "max_retries": 0,
                "timeout": 15.0,
            }
            client = openai.OpenAI(**kwargs)
        if provider == "openrouter":
            client.get("/key", cast_to=dict)
        else:
            client.models.list()
    except Exception as exc:
        if isinstance(exc, auth_error):
            return {"ok": False, "source": source, "error": REJECTED}
        return {"ok": False, "source": source, "error": redact(f"{type(exc).__name__}: {exc}", key)}
    return {"ok": True, "source": source, "error": None}
