"""GET /health and GET /ready in serve mode."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

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


@router.get("/metrics")
def metrics(request: Request) -> Response:
    """The Prometheus text, only when `ServeSettings.metrics_on_app` is true.
    It must not face the internet (docs/pandion-api.md, "Metrics")."""
    state = request.app.state
    if not state.serve.metrics_on_app:
        raise HTTPException(status_code=404, detail="Not Found")
    from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

    return Response(generate_latest(state.metrics.registry), media_type=CONTENT_TYPE_LATEST)
