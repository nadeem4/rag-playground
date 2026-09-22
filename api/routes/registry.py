"""The plugin catalogue, the stage explanations, and per-settings explanations."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from core.ports import STAGE_WHAT, Stage
from core.registry import UnknownTransformError

router = APIRouter()


@router.get("/registry")
def get_registry(request: Request) -> dict[str, Any]:
    return request.app.state.deps.registry.export_schema()


@router.get("/stages")
def get_stages() -> dict[str, dict[str, str]]:
    """What every step is for in RAG, keyed by stage (I-12)."""
    return {str(stage): {"what": STAGE_WHAT[stage]} for stage in Stage}


class ExplainIn(BaseModel):
    #: A plain string, not `Stage`, so an unknown stage is a 404 like an
    #: unknown transform rather than a request-validation 422.
    stage: str
    transform: str
    config: dict[str, Any] = Field(default_factory=dict)


@router.post("/explain")
def explain(body: ExplainIn, request: Request) -> dict[str, Any]:
    """What one transform will do with one config (I-12).

    Pure: the config is validated and `explain()` reads it. No model is loaded,
    nothing is run, nothing is stored.
    """
    try:
        stage = Stage(body.stage)
        cls = request.app.state.deps.registry.get(stage, body.transform)
    except (ValueError, UnknownTransformError) as exc:
        raise HTTPException(
            status_code=404, detail=f"unknown transform {body.stage}/{body.transform}"
        ) from exc
    try:
        config = cls.config_model(**body.config)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail={"errors": json.loads(exc.json())}
        ) from exc
    return cls().explain(config).model_dump()
