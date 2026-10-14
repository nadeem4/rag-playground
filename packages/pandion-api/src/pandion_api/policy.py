"""Site rules: one object whose methods the routes call. The default allows everything.

A site subclasses `Policy` and overrides only what it needs. Every method that
judges a request is given it, so a rule can depend on who asks (a cookie, a
header). A method refuses by raising `fastapi.HTTPException` with the status
and the sentence the caller should see. See docs/pandion-api.md, "Site rules".
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI


class Policy:
    def dependencies(self) -> list[Any]:
        """FastAPI dependencies (`fastapi.Depends(...)`) run on every route,
        for example one that sets a visitor cookie."""
        return []

    async def on_startup(self, app: FastAPI) -> None:
        """Called once before the server takes requests."""

    async def on_shutdown(self, app: FastAPI) -> None:
        """Called once after the server stops taking requests."""
