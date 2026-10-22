"""Site rules: one object whose methods the routes call. The default allows everything.

A site subclasses `Policy` and overrides only what it needs. Every method that
judges a request is given it, so a rule can depend on who asks (a cookie, a
header). A method refuses by raising `fastapi.HTTPException` with the status
and the sentence the caller should see. See docs/pandion-api.md, "Site rules".
"""

from __future__ import annotations

import os
from contextlib import AbstractContextManager, nullcontext
from typing import Any

from fastapi import FastAPI, HTTPException, Request, UploadFile

from pandion_api.credentials import PROVIDERS
from pandion_api.documents import Document


class Policy:
    #: The 403 a run gets for a document can_read refuses.
    not_readable = "This document is not available."
    #: What a question-set report says when the set was checked but not kept.
    not_keeping_note = "This server checked your questions but did not keep them."

    def dependencies(self) -> list[Any]:
        """FastAPI dependencies (`fastapi.Depends(...)`) run on every route,
        for example one that sets a visitor cookie."""
        return []

    # --- documents --------------------------------------------------------------

    def can_read(self, sha: str, request: Request) -> bool:
        """May this request read the document with this id (its pages, its file,
        its questions, or a run on it)?"""
        return True

    def document_name(self, sha: str, request: Request) -> str | None:
        """The name of a stored file that has no record, such as one a site
        seeded into a fresh store, or None to name it by its stored file
        (`<sha>.pdf`). A run and a question set across documents call it by this
        name, so a question can name it."""
        return None

    async def check_upload(self, file: UploadFile, request: Request) -> bytes:
        """Read the upload and return its bytes, or raise to refuse it. Read no
        more than you accept: `await file.read(limit + 1)`. What the bytes may
        be is `check_document`'s to judge, for an upload and a URL alike."""
        return await file.read()

    def check_document(self, data: bytes, filename: str, request: Request) -> None:
        """Refuse a document's bytes before they are kept (raise HTTPException):
        an upload's after `check_upload` read them, and a URL document's after
        the fetch. `filename` is the upload's name, or the one the fetch gave
        (such as `example.com-guide.html`). The default takes any bytes."""

    def check_fetch(self, url: str, request: Request) -> None:
        """Refuse a URL document before anything is fetched (raise
        HTTPException), for example a rate limit. A fetch that then fails
        still came through here, so it counts."""

    def fetch_slot(self, request: Request) -> AbstractContextManager[Any]:
        """A context the fetch runs inside, for example one that holds one of a
        few slots, or raises HTTPException when none is free. It is left even
        when the fetch fails. The default does nothing."""
        return nullcontext()

    def max_url_bytes(self, request: Request) -> int:
        """The most a URL document may be, in bytes: the fetch stops reading one
        byte past it and refuses the page with a 413. The default is Pandion's
        own limit for a URL in a pipeline, 20 MB."""
        return 20 * 1024 * 1024

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

    def keeps_question_sets(self, request: Request) -> bool:
        """Keep a checked question set on the server? False: check it, keep nothing."""
        return True

    # --- runs -------------------------------------------------------------------

    def max_active_runs(self) -> int | None:
        """How many runs may work at once; the rest wait their turn. None: no limit."""
        return None

    def strategies(self, catalog: dict[str, Any], request: Request) -> dict[str, Any]:
        """The catalog a client is shown (a copy: change it freely)."""
        return catalog

    def check_run(self, config: dict[str, Any], request: Request) -> None:
        """Refuse a pipeline before it runs (raise HTTPException). `config` is
        the pipeline file's shape, with the server's path and models in it.
        It holds each value as the request sent it, not as Pandion will read
        it: a number may come as a string ("16001") or a float (16001.0) that
        pydantic later makes an int. A site that compares numbers must coerce
        them first, for example with `pydantic.TypeAdapter(int).validate_python`."""

    def public_endpoints_only(self, request: Request) -> bool:
        """A step that calls a custom model endpoint accepts only a public https address."""
        return False

    def max_variants(self, request: Request) -> int:
        """How many variants one comparison may run, which bounds the work one
        request can ask for."""
        return 10

    def check_question_count(self, kind: str, count: int, request: Request) -> None:
        """Refuse a run that asks too many questions (raise HTTPException), which
        bounds the work one request can ask for. `kind` is "evaluation", where
        `count` is its questions, "comparison", where `count` is its variants
        times its questions, or "generation", where `count` is the questions a
        model is asked to write. Called before the run starts, after the route's
        own cap (500 questions a set; 50 questions a model writes)."""

    def max_runs_per_owner(self, request: Request) -> int | None:
        """How many runs one owner (`run_owner`) may have working or waiting at
        once. A run past it is refused with a 429. None: no limit. A run with no
        owner is never counted."""
        return None

    def run_owner(self, request: Request) -> str | None:
        """Who a run started by `request` belongs to, for example a visitor's
        cookie. A run with an owner is for that owner only. None: anyone may
        follow or cancel it."""
        return None

    # --- the cache -----------------------------------------------------------------

    def check_clear_cache(self, request: Request) -> None:
        """Refuse DELETE /cache (raise HTTPException), for example where many share one cache."""

    # --- keys ---------------------------------------------------------------------

    def server_key(self, provider: str) -> tuple[str | None, str]:
        """(key, source) the server itself has for `provider`: its environment
        variable ("env"), else (None, "none")."""
        key = (os.environ.get(PROVIDERS[provider].env_var) or "").strip()
        return (key, "env") if key else (None, "none")

    def key(self, provider: str, request: Request) -> tuple[str | None, str]:
        """(key, source) for this request: its header ("header"), else the server's."""
        header = (request.headers.get(PROVIDERS[provider].header) or "").strip()
        return (header, "header") if header else self.server_key(provider)

    def credentials(self, request: Request) -> dict[str, str]:
        """The keys a run gets, as Pandion's `credentials=` names them."""
        out: dict[str, str] = {}
        for provider, spec in PROVIDERS.items():
            key, _ = self.key(provider, request)
            if key:
                out[spec.extra] = key
        return out

    def missing_key(self, provider: str) -> str:
        """What a key check says when there is no key: where one can go."""
        spec = PROVIDERS[provider]
        return (
            f"no API key: send one in the {spec.header} header, or set {spec.env_var} "
            "for the server process"
        )

    def check_provider(self, provider: str, request: Request) -> None:
        """Refuse a key check for this provider (raise HTTPException)."""

    # --- what leaves the server -----------------------------------------------------

    def scrub(self, text: str) -> str:
        """An error message as it may leave the server, for example with the
        server's file paths taken out. The default leaves it as it is."""
        return text

    async def on_startup(self, app: FastAPI) -> None:
        """Called once before the server takes requests."""

    async def on_shutdown(self, app: FastAPI) -> None:
        """Called once after the server stops taking requests."""
