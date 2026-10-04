"""App and LLM settings: demo mode, which key source the server has for each
provider, and whether a key works.

Neither endpoint ever returns a key. `GET` reports only the source the *server*
can supply, per provider; `check` makes one call that costs no tokens:
`models.list()`, or for OpenRouter, whose model list is public, `GET /key`,
which needs a valid key.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel

from api import demo, visitor
from api.credentials import PROVIDERS, redact, resolve_key, server_source
from providers.endpoints import EndpointRefused, guard_endpoint
from providers.llm import OPENROUTER_BASE_URL, openai_client_kwargs

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
    "openrouter": (
        "no API key: type one in the UI, set OPENROUTER_API_KEY for the server "
        "process, or put it in .env at the repo root"
    ),
}
NO_BASE_URL = "no base URL: send the custom endpoint's base URL to check it"
REJECTED = "authentication failed: the API key was rejected"
DEMO_NO_CUSTOM = "custom endpoints are disabled in this hosted demo"


class CheckIn(BaseModel):
    provider: Literal["anthropic", "openai", "custom", "openrouter"] = "anthropic"
    #: Only for `custom`: the OpenAI-compatible server to check.
    base_url: str | None = None


@router.get("/settings/app")
def get_app_settings(request: Request, response: Response) -> dict[str, Any]:
    """`demo`: only a key typed in the UI is used, and uploads are private and bounded.
    Also the moment every page load first talks to the server, so the visitor cookie is minted here."""
    visitor.ensure_visitor(request, response)
    return {"demo": True, "limits": demo.limits()} if demo.enabled() else {"demo": False}


@router.get("/settings/llm")
def get_llm_settings() -> dict[str, str]:
    return {provider: server_source(provider) for provider in PROVIDERS}


@router.post("/settings/llm/check")
def check_llm_key(
    body: CheckIn | None = None,
    x_anthropic_api_key: str | None = Header(default=None),
    x_openai_api_key: str | None = Header(default=None),
    x_custom_api_key: str | None = Header(default=None),
    x_openrouter_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    body = body or CheckIn()
    headers = {
        "anthropic": x_anthropic_api_key,
        "openai": x_openai_api_key,
        "custom": x_custom_api_key,
        "openrouter": x_openrouter_api_key,
    }
    provider = body.provider
    if provider == "custom" and demo.enabled():
        raise HTTPException(status_code=403, detail=DEMO_NO_CUSTOM)
    key, source = resolve_key(headers[provider], provider)
    if provider == "custom":
        if not body.base_url:
            return {"ok": False, "source": source, "error": NO_BASE_URL}
        try:
            guard_endpoint(body.base_url)
        except EndpointRefused as exc:
            return {"ok": False, "source": source, "error": str(exc)}
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
            base_url = {"custom": body.base_url, "openrouter": OPENROUTER_BASE_URL}.get(
                provider
            )
            kwargs: dict[str, Any] = {
                **openai_client_kwargs(key, base_url),
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
        return {
            "ok": False,
            "source": source,
            "error": redact(f"{type(exc).__name__}: {exc}", key),
        }
    return {"ok": True, "source": source, "error": None}
