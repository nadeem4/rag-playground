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

    def strategies(self, catalog: dict[str, Any], request: Request) -> dict[str, Any]:
        """The catalog a client is shown (a copy: change it freely)."""
        return catalog

    def check_run(self, config: dict[str, Any], request: Request) -> None:
        """Refuse a pipeline before it runs (raise HTTPException). `config` is
        the pipeline file's shape, with the server's path and models in it."""

    def public_endpoints_only(self, request: Request) -> bool:
        """A step that calls a custom model endpoint accepts only a public https address."""
        return False

    def run_owner(self, request: Request) -> str | None:
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
