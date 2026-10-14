"""The playground's site rules, as a pandion-api Policy.

Demo mode (`api.demo`) is read on every call, so a test can turn it on and off.
Each rule is implemented once: a method here calls the function the old /api
route uses, or the old route calls this policy, so the old routes and /api/v2
cannot drift apart before part 5 retires the old ones.
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import FastAPI

from pandion_api import Policy

from api import demo, expiry
from api.routes import sources


class PlaygroundPolicy(Policy):
    def __init__(self) -> None:
        self._sweeper: asyncio.Task | None = None

    def max_active_runs(self) -> int | None:
        """A few runs at once on the shared demo; no limit locally."""
        return demo.MAX_ACTIVE_RUNS if demo.enabled() else None

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
