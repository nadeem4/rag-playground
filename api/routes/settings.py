"""App and LLM settings: demo mode, which key source the server has for each
provider, and whether a key works.

Neither endpoint ever returns a key. `GET` reports only the source the *server*
can supply, per provider; `check` makes one call that costs no tokens
(`pandion_api.keycheck.check_key`, which /api/v2/settings/models/check calls too).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Header, Request, Response
from pydantic import BaseModel

from api import demo, visitor
from api.credentials import PROVIDERS, resolve_key, server_source
from pandion_api.keycheck import NO_BASE_URL, REJECTED, check_key  # noqa: F401 (re-exported)

router = APIRouter()

def no_key(provider: str) -> str:
    """Why there is nothing to check. Only off the demo can a visitor set a
    server variable or a `.env` entry, so only there are they mentioned."""
    if demo.enabled():
        return "no API key: type one in the UI"
    return (
        f"no API key: type one in the UI, set {PROVIDERS[provider].env_var} for "
        "the server process, or put it in .env at the repo root"
    )


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
    request: Request,
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
    # The site's rule (the demo checks no custom endpoint) lives in its Policy,
    # which /api/v2/settings/models/check asks too.
    request.app.state.policy.check_provider(provider, request)
    key, source = resolve_key(headers[provider], provider)
    return check_key(
        provider,
        key,
        source,
        base_url=body.base_url,
        public_only=demo.public_endpoints_only(),
        missing=no_key(provider),
    )
