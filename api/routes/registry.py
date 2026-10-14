"""The plugin catalogue, the stage explanations, and per-settings explanations."""

from __future__ import annotations

import copy
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from api import demo
from api.stage_copy import STAGE_LESSON, STAGE_WHAT
from pandion.extend import Stage
from pandion.registry import UnknownTransformError

router = APIRouter()


@router.get("/registry")
def get_registry(request: Request) -> dict[str, Any]:
    """The catalogue. On the demo, the custom endpoint is left out of every
    model choice, with its two fields: a run that picks it is refused with 403
    anyway. The test-only embedder is left out too. Read-only settings (the
    prompts) are left out everywhere until the forms can show them read-only."""
    schema = _without_read_only(request.app.state.deps.registry.export_schema())
    return _without_test_options(_without_custom_models(schema)) if demo.enabled() else schema


#: Choices that exist for the test suite, not for a learner.
TEST_ONLY = {("index", "embedder"): {"fake-deterministic"}}


def _without_test_options(schema: dict[str, Any]) -> dict[str, Any]:
    """`schema` (already a copy) with the test-only choices and the custom endpoint's fields removed."""
    for stage, transforms in schema.items():
        for info in transforms.values():
            props = info["config_schema"].get("properties", {})
            for (s, key), drop in TEST_ONLY.items():
                if s == stage and key in props and "enum" in props[key]:
                    props[key]["enum"] = [v for v in props[key]["enum"] if v not in drop]
                    if "x-labels" in props[key]:
                        props[key]["x-labels"] = {v: t for v, t in props[key]["x-labels"].items() if v not in drop}
            for key in ("custom_base_url", "custom_model"):
                props.pop(key, None)
    return schema


def _without_custom_models(schema: dict[str, Any]) -> dict[str, Any]:
    """A copy with every model choice whose provider is a custom endpoint
    (`x-providers`) dropped from `enum`, `x-labels` and `x-providers`."""
    out = copy.deepcopy(schema)
    for transforms in out.values():
        for info in transforms.values():
            field = info["config_schema"].get("properties", {}).get("model") or {}
            providers = field.get("x-providers")
            if not providers:
                continue
            custom = {m for m, p in providers.items() if p == "openai_compatible"}
            field["enum"] = [m for m in field.get("enum", []) if m not in custom]
            for key in ("x-labels", "x-providers"):
                field[key] = {m: v for m, v in field[key].items() if m not in custom}
    return out


def read_only_settings(properties: dict[str, Any]) -> list[str]:
    """The settings a config schema's `properties` mark `readOnly` (the prompts).

    The registry leaves them out of the forms and the run routes refuse a
    changed one, both through this function, so the two cannot drift."""
    return [key for key, prop in properties.items() if prop.get("readOnly")]


def _without_read_only(schema: dict[str, Any]) -> dict[str, Any]:
    """A copy without the settings marked readOnly (the prompts): the forms
    cannot show a setting read-only yet, and a visitor must not edit them."""
    out = copy.deepcopy(schema)
    for transforms in out.values():
        for info in transforms.values():
            props = info["config_schema"].get("properties", {})
            for key in read_only_settings(props):
                del props[key]
    return out


@router.get("/stages")
def get_stages() -> dict[str, dict[str, Any]]:
    """What every step is for in RAG, keyed by stage (I-12), plus the stage's
    Learn-mode lesson where one is written (I-22)."""
    out: dict[str, dict[str, Any]] = {}
    for stage in Stage:
        out[str(stage)] = {"what": STAGE_WHAT[stage]}
        if stage in STAGE_LESSON:
            out[str(stage)]["lesson"] = STAGE_LESSON[stage]
    return out


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
