"""App and LLM settings: demo mode, which key source the server has, and
whether a key works.

Neither endpoint ever returns a key. `GET` reports only the source the *server*
can supply; `check` makes one `models.list()` call, which costs no tokens.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from api import demo
from api.credentials import redact, resolve_key, server_source

router = APIRouter()

NO_KEY = (
    "no API key: type one in the UI, set ANTHROPIC_API_KEY for the server "
    "process, or put it in .env at the repo root"
)
REJECTED = "authentication failed: the API key was rejected"


@router.get("/settings/app")
def get_app_settings() -> dict[str, bool]:
    """`demo`: uploads are off and only a key typed in the UI is used."""
    return {"demo": demo.enabled()}


@router.get("/settings/llm")
def get_llm_settings() -> dict[str, str]:
    return {"source": server_source()}


@router.post("/settings/llm/check")
def check_llm_key(
    x_anthropic_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    key, source = resolve_key(x_anthropic_api_key)
    if not key:
        return {"ok": False, "source": source, "error": NO_KEY}

    import anthropic  # deferred: only this endpoint needs the SDK

    try:
        anthropic.Anthropic(api_key=key, max_retries=0, timeout=15.0).models.list()
    except anthropic.AuthenticationError:
        return {"ok": False, "source": source, "error": REJECTED}
    except Exception as exc:
        return {
            "ok": False,
            "source": source,
            "error": redact(f"{type(exc).__name__}: {exc}", key),
        }
    return {"ok": True, "source": source, "error": None}
