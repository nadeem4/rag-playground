"""App settings: demo mode and its limits.

Which key source the server has, and whether a key works, are pandion-api's
`GET /api/v2/settings/models` and `POST /api/v2/settings/models/check`;
`no_key` is the sentence the check gives when there is no key.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from api import demo, visitor
from api.credentials import PROVIDERS

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


@router.get("/settings/app")
def get_app_settings(request: Request, response: Response) -> dict[str, Any]:
    """`demo`: only a key typed in the UI is used, and uploads are private and bounded.
    Also the moment every page load first talks to the server, so the visitor cookie is minted here."""
    visitor.ensure_visitor(request, response)
    return {"demo": True, "limits": demo.limits()} if demo.enabled() else {"demo": False}
