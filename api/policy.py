"""The playground's site rules, as a pandion-api Policy.

Demo mode (`api.demo`) is read on every call, so a test can turn it on and off.
Each rule is implemented once: a method here calls the function the old /api
route uses, or the old route calls this policy, so the old routes and /api/v2
cannot drift apart before part 5 retires the old ones.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import FastAPI, HTTPException, Request

import pandion
from pandion_api import Policy
from pandion_api.checks import changed_read_only_settings, custom_endpoint_steps, steps

from api import demo, expiry
from api.routes import sources
from api.routes.registry import served_catalog
from api.routes.runs import DEMO_NO_CUSTOM, PROMPTS_FIXED

#: The most a model step may write, in tokens (`max_tokens` on a step that calls a model).
MAX_OUTPUT_TOKENS = 16000
#: A text budget (a setting named `*_budget_chars`) may be at most this many times its default.
BUDGET_TIMES = 4


def over_limit(config: dict[str, Any]) -> str | None:
    """The sentence refusing the first setting in `config` above the playground's
    cap, or None: `max_tokens` on a step that calls a model above
    MAX_OUTPUT_TOKENS, and a text budget above BUDGET_TIMES its default. A long
    output or a long prompt costs the key that pays for it, and on the demo
    holds one of the few run slots."""
    catalog = pandion.catalog()
    for where, stage, use, settings in steps(config):
        props = catalog.get(stage, {}).get(use, {}).get("config_schema", {}).get("properties", {})
        for key, value in settings.items():
            if not isinstance(value, int) or key not in props:
                continue
            if key == "max_tokens" and "model" in props:
                cap = MAX_OUTPUT_TOKENS
            elif key.endswith("_budget_chars") and isinstance(props[key].get("default"), int):
                cap = BUDGET_TIMES * props[key]["default"]
            else:
                continue
            if value > cap:
                return f"{where}.{key} is {value}; the playground allows at most {cap}."
    return None


class PlaygroundPolicy(Policy):
    def __init__(self) -> None:
        self._sweeper: asyncio.Task | None = None

    def max_active_runs(self) -> int | None:
        """A few runs at once on the shared demo; no limit locally."""
        return demo.MAX_ACTIVE_RUNS if demo.enabled() else None

    def strategies(self, catalog: dict[str, Any], request: Request) -> dict[str, Any]:
        return served_catalog(catalog)

    def check_run(self, config: dict[str, Any], request: Request) -> None:
        """On the demo, no custom endpoint: the server would send a request to a
        URL a visitor chose. In every mode, no changed prompt or model revision:
        the app has no control for them, so a changed one comes from a crafted
        request or a shared link, and would run on another visitor's key. Then
        no model output or text budget above the playground's caps."""
        if demo.enabled() and custom_endpoint_steps(config):
            raise HTTPException(status_code=403, detail=DEMO_NO_CUSTOM)
        if changed_read_only_settings(config):
            raise HTTPException(status_code=403, detail=PROMPTS_FIXED)
        refusal = over_limit(config)
        if refusal:
            raise HTTPException(status_code=403, detail=refusal)

    def public_endpoints_only(self, request: Request) -> bool:
        return demo.public_endpoints_only()

    async def on_startup(self, app: FastAPI) -> None:
        """Put every sample's file in the store; on the demo, start expiring uploads."""
        folder = app.state.deps.sources_dir
        sources.seed_sample_files(folder)
        if demo.enabled():
            self._sweeper = asyncio.create_task(expiry.run_forever(folder))

    async def on_shutdown(self, app: FastAPI) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sweeper
            self._sweeper = None
