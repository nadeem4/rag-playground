"""GET /health and GET /ready in serve mode."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/health")
def health() -> dict[str, str]:
    """Is the process up. It names no version."""
    return {"status": "ok"}


@router.get("/ready")
def ready(request: Request):
    """Can this server answer: the conversation store opens and the pipeline's
    index is there. The reason for a no goes to the log, never to the caller."""
    try:
        check = getattr(request.app.state.conversations, "check", None)
        if check is not None:
            check()
        status = request.app.state.pipeline.index.index_status()
        if not status.ready:
            raise RuntimeError(status.reason)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Not ready: %s", exc)
        return JSONResponse(status_code=503, content={"ready": False})
    return {"ready": True}
