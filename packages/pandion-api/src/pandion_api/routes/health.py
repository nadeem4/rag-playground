"""GET /health: is the server up, and which versions does it run."""

from __future__ import annotations

from fastapi import APIRouter

import pandion
from pandion_api.version import VERSION

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "pandion": pandion.__version__, "pandion_api": VERSION}
