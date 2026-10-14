"""What every stage is for (`GET /api/stages`), and the catalog as the playground serves it.

`PlaygroundPolicy.strategies` serves the catalog through `served_catalog`, so
GET /api/v2/strategies leaves out what a visitor must not set.
"""

from __future__ import annotations

import copy
from typing import Any

from fastapi import APIRouter

from api import demo
from api.stage_copy import STAGE_LESSON, STAGE_WHAT
from pandion.extend import Stage

router = APIRouter()


def served_catalog(schema: dict[str, Any]) -> dict[str, Any]:
    """The catalog as the playground serves it: read-only settings left out
    everywhere; on the demo, the custom endpoint and the test-only embedder too.
    `schema` is not changed. PlaygroundPolicy serves through this function."""
    served = _without_read_only(schema)
    return _without_test_options(_without_custom_models(served)) if demo.enabled() else served


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

    The served catalog leaves them out of the forms through this function."""
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
