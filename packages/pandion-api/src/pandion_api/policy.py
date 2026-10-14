"""Site rules: one object whose methods the routes call. The default allows everything.

A site subclasses `Policy` and overrides only what it needs. Every method that
judges a request is given it, so a rule can depend on who asks (a cookie, a
header). A method refuses by raising `fastapi.HTTPException` with the status
and the sentence the caller should see. See docs/pandion-api.md, "Site rules".
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request


class Policy:
    def dependencies(self) -> list[Any]:
        """FastAPI dependencies (`fastapi.Depends(...)`) run on every route,
        for example one that sets a visitor cookie."""
        return []

    def max_active_runs(self) -> int | None:
        """How many runs may work at once; the rest wait their turn. None: no limit."""
        return None

    def run_owner(self, request: Request | None) -> str | None:
        """Who a run started by `request` belongs to, for example a visitor's
        cookie. A run with an owner is for that owner only. None: anyone may
        follow or cancel it."""
        return None

    def scrub(self, text: str) -> str:
        """An error message as it may leave the server, for example with the
        server's file paths taken out. The default leaves it as it is."""
        return text

    async def on_startup(self, app: FastAPI) -> None:
        """Called once before the server takes requests."""

    async def on_shutdown(self, app: FastAPI) -> None:
        """Called once after the server stops taking requests."""
