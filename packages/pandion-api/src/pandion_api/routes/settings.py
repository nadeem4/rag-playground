"""Which model keys the server has, and whether a key works. Never a key."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from pandion_api.credentials import PROVIDERS
from pandion_api.deps import get_policy
from pandion_api.keycheck import check_key
from pandion_api.policy import Policy

router = APIRouter()


class CheckIn(BaseModel):
    provider: Literal["anthropic", "openai", "custom", "openrouter"] = "anthropic"
    #: Only for `custom`: the OpenAI-compatible server to check.
    base_url: str | None = None


@router.get("/settings/models")
def model_keys(policy: Policy = Depends(get_policy)) -> dict[str, str]:
    """Where the server's own key for each provider comes from ("none" when it has none)."""
    return {provider: policy.server_key(provider)[1] for provider in PROVIDERS}


@router.post("/settings/models/check")
def check_model_key(
    request: Request,
    body: CheckIn | None = None,
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    """Whether the key this request would use for `provider` works."""
    body = body or CheckIn()
    policy.check_provider(body.provider, request)
    key, source = policy.key(body.provider, request)
    return check_key(
        body.provider,
        key,
        source,
        base_url=body.base_url,
        public_only=policy.public_endpoints_only(request),
        missing=policy.missing_key(body.provider),
    )
