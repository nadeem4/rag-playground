"""Site rules: one object whose methods the routes call. The default allows everything.

A site subclasses `Policy` and overrides only what it needs. Every method that
judges a request is given it, so a rule can depend on who asks (a cookie, a
header). A method refuses by raising `fastapi.HTTPException` with the status
and the sentence the caller should see. See docs/pandion-api.md, "Site rules".
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request, UploadFile

from pandion_api.documents import Document


class Policy:
    def dependencies(self) -> list[Any]:
        """FastAPI dependencies (`fastapi.Depends(...)`) run on every route,
        for example one that sets a visitor cookie."""
        return []

    # --- documents --------------------------------------------------------------

    def can_read(self, sha: str, request: Request) -> bool:
        """May this request read the document with this id (its pages, its file,
        its questions, or a run on it)?"""
        return True

    async def check_upload(self, file: UploadFile, request: Request) -> bytes:
        """Read the upload and return its bytes, or raise to refuse it. Read no
        more than you accept: `await file.read(limit + 1)`."""
        return await file.read()

    def on_uploaded(self, document: Document, request: Request) -> None:
        """Called with the store's lock held, right after the record is written,
        for example to note who uploaded it in the record."""

    def on_delete(self, sha: str, document: Document | None, request: Request) -> bool:
        """Called with the store's lock held. Raise to refuse; return True to
        delete the file now, False to keep it (another owner still holds it).
        `document` is None when there is no record."""
        if document is None:
            raise HTTPException(status_code=404, detail="There is no document with that fingerprint.")
        return True

    def describe(self, document: Document, request: Request) -> dict[str, Any]:
        """Keys to add to a document in the list, for this caller."""
        return {}

    def private(self, sha: str, request: Request) -> bool:
        """Is this document one caller's own? Its page images are then cached privately."""
        return False

    # --- runs -------------------------------------------------------------------

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
