"""What strategies there are, what one will do, and whether a pipeline is valid."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import pandion
from pandion import ConfigError
from pandion_api.deps import get_policy
from pandion_api.pipelines import as_yaml, prepare, problems, public
from pandion_api.policy import Policy

router = APIRouter()


@router.get("/strategies")
def strategies(request: Request, policy: Policy = Depends(get_policy)) -> dict[str, Any]:
    """Every strategy by stage with its settings as a JSON schema, as the
    policy shows them, and the strategy a new pipeline starts with per part."""
    return {"stages": policy.strategies(pandion.catalog(), request), "defaults": pandion.defaults()}


class ExplainIn(BaseModel):
    stage: str
    use: str
    settings: dict[str, Any] = Field(default_factory=dict)


@router.post("/explain")
def explain(body: ExplainIn, policy: Policy = Depends(get_policy)) -> dict[str, Any]:
    """What one strategy will do with these settings. Nothing runs."""
    try:
        return pandion.explain(body.stage, body.use, body.settings)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=policy.scrub(str(exc.args[0]))) from None
    except ConfigError as exc:
        raise problems(policy.scrub(str(exc))) from None


class ValidateIn(BaseModel):
    config: Any


@router.post("/pipelines/validate")
def validate(body: ValidateIn, request: Request) -> dict[str, Any]:
    """Whether this pipeline would run here: its problems, one sentence each,
    or the pipeline in the file's shape. A site rule's refusal keeps its status."""
    try:
        p = prepare(body.config, request)
    except HTTPException as exc:
        # Only prepare's own problems become a 200; anything else a Policy
        # raised, even a 422, keeps its status and detail.
        if exc.status_code == 422 and isinstance(exc.detail, dict) and "problems" in exc.detail:
            return {"ok": False, "problems": exc.detail["problems"]}
        raise
    config = public(p)
    return {"ok": True, "problems": [], "config": config, "yaml": as_yaml(config)}
