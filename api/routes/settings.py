"""App and LLM settings: demo mode, which key source the server has for each
provider, and whether a key works.

Neither endpoint ever returns a key. `GET` reports only the source the *server*
can supply, per provider; `check` makes one `models.list()` call, which costs
no tokens.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from api import demo
from api.credentials import PROVIDERS, redact, resolve_key, server_source
from providers.llm import NO_KEY_PLACEHOLDER

router = APIRouter()

NO_KEY = {
    "anthropic": (
        "no API key: type one in the UI, set ANTHROPIC_API_KEY for the server "
        "process, or put it in .env at the repo root"
    ),
    "openai": (
        "no API key: type one in the UI, set OPENAI_API_KEY for the server "
        "process, or put it in .env at the repo root"
    ),
}
NO_BASE_URL = "no base URL: send the custom endpoint's base URL to check it"
REJECTED = "authentication failed: the API key was rejected"
DEMO_NO_CUSTOM = "custom endpoints are disabled in this hosted demo"


class CheckIn(BaseModel):
    provider: Literal["anthropic", "openai", "custom"] = "anthropic"
    #: Only for `custom`: the OpenAI-compatible server to check.
    base_url: str | None = None


@router.get("/settings/app")
def get_app_settings() -> dict[str, bool]:
    """`demo`: uploads are off and only a key typed in the UI is used."""
    return {"demo": demo.enabled()}


@router.get("/settings/llm")
def get_llm_settings() -> dict[str, str]:
    return {provider: server_source(provider) for provider in PROVIDERS}


@router.post("/settings/llm/check")
def check_llm_key(
    body: CheckIn | None = None,
    x_anthropic_api_key: str | None = Header(default=None),
    x_openai_api_key: str | None = Header(default=None),
    x_custom_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    body = body or CheckIn()
    headers = {
        "anthropic": x_anthropic_api_key,
        "openai": x_openai_api_key,
        "custom": x_custom_api_key,
    }
    provider = body.provider
    if provider == "custom" and demo.enabled():
        raise HTTPException(status_code=403, detail=DEMO_NO_CUSTOM)
    key, source = resolve_key(headers[provider], provider)
    if provider == "custom":
        if not body.base_url:
            return {"ok": False, "source": source, "error": NO_BASE_URL}
    elif not key:
        return {"ok": False, "source": source, "error": NO_KEY[provider]}

    try:
        if provider == "anthropic":
            import anthropic  # deferred: only this endpoint needs the SDKs

            auth_error: type[Exception] = anthropic.AuthenticationError
            client = anthropic.Anthropic(api_key=key, max_retries=0, timeout=15.0)
        else:
            import openai

            auth_error = openai.AuthenticationError
            kwargs: dict[str, Any] = {
                "api_key": key or NO_KEY_PLACEHOLDER,
                "max_retries": 0,
                "timeout": 15.0,
            }
            if provider == "custom":
                kwargs["base_url"] = body.base_url
            client = openai.OpenAI(**kwargs)
        client.models.list()
    except Exception as exc:
        if isinstance(exc, auth_error):
            return {"ok": False, "source": source, "error": REJECTED}
        return {
            "ok": False,
            "source": source,
            "error": redact(f"{type(exc).__name__}: {exc}", key),
        }
    return {"ok": True, "source": source, "error": None}
