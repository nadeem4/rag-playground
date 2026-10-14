"""The playground's site rules, as a pandion-api Policy.

Demo mode (`api.demo`) is read on every call, so a test can turn it on and off.
Each rule is implemented once: a method here calls the function the old /api
route uses, or the old route calls this policy, so the old routes and /api/v2
cannot drift apart before part 5 retires the old ones.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response, UploadFile

import pandion
from pandion_api import Policy
from pandion_api.checks import changed_read_only_settings, custom_endpoint_steps, steps
from pandion_api.documents import META_DIR, Document

from api import credentials, demo, expiry, sample_set, visitor
from api.routes import sources
from api.routes.artifacts import NO_CLEARING
from api.routes.questions import NO_STORING
from api.routes.registry import served_catalog
from api.routes.runs import DEMO_NO_CUSTOM, MAX_VARIANTS, NOT_AVAILABLE, PROMPTS_FIXED

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
        refusal = step_over_limit(where, stage, use, settings, catalog)
        if refusal:
            return refusal
    return None


def step_over_limit(
    where: str, stage: str, use: str, settings: dict[str, Any], catalog: dict[str, Any] | None = None
) -> str | None:
    """`over_limit` for one step: `where` names it in the sentence. The old
    /api/runs and /api/sweeps call this on each graph node, so both stacks
    refuse the same settings with the same 403."""
    catalog = catalog if catalog is not None else pandion.catalog()
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


def _mint_visitor(request: Request, response: Response) -> None:
    """Every /api/v2 request carries a visitor id. A new one goes out on the
    response's cookie; this request's handlers read it from request.state."""
    request.state.visitor = visitor.ensure_visitor(request, response)


def _visitor(request: Request) -> str | None:
    """The cookie's visitor id, or the one just minted for this request."""
    return visitor.visitor_id(request) or getattr(request.state, "visitor", None)


#: What a server path is replaced with; its last part is kept after it.
SERVER_PATH = "[server]"

#: An absolute path: quoted (it may hold spaces), or bare up to a space or a
#: quote. Windows (`C:\...`, `C:/...`), a share (`\\host\...`), or POSIX with at
#: least two parts (`/usr/lib`), not inside a web address (`https://host/v1`).
_PATH = re.compile(
    r"""(?P<q>["'])(?P<quoted>(?:[A-Za-z]:[\\/]|\\\\|/)[^"'\n]*?)(?P=q)"""
    r"""|(?P<bare>(?:\b[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+|(?<![\w:/.~-])/[^\s"'<>|:/]+(?:/[^\s"'<>|:]*)+)"""
)


def scrub_paths(text: str, data_dir: Path | None = None) -> str:
    """`text` with the data folder and every absolute path replaced by
    SERVER_PATH and the path's last part (`[server]/x.py`)."""
    if data_dir is not None:
        # First, whole: the folder's name may hold a space, where a bare match stops.
        folder = Path(data_dir).resolve()
        # Only where it ends a path part: `/data` is not the start of `/database`
        # or of `https://huggingface.co/datasets/x`, but `(/data)`, `in /data.`
        # and `/data, then` are scrubbed.
        for form in sorted({str(folder), folder.as_posix()}, key=len, reverse=True):
            text = re.sub(re.escape(form) + r"(?![\w-]|\.\w)", lambda _: SERVER_PATH, text)

    def short(match: re.Match[str]) -> str:
        path = match.group("quoted") or match.group("bare")
        last = re.split(r"[\\/]", path.rstrip("\\/"))[-1]
        shown = f"{SERVER_PATH}/{last}" if last else SERVER_PATH
        quote = match.group("q") or ""
        return f"{quote}{shown}{quote}"

    return _PATH.sub(short, text)


class PlaygroundPolicy(Policy):
    not_readable = NOT_AVAILABLE
    not_keeping_note = NO_STORING

    def __init__(self) -> None:
        self._sweeper: asyncio.Task | None = None
        self._data_dir: Path | None = None

    def dependencies(self) -> list[Any]:
        return [Depends(_mint_visitor)]

    # --- documents --------------------------------------------------------------

    def can_read(self, sha: str, request: Request) -> bool:
        return demo.readable(sha, request)

    async def check_upload(self, file: UploadFile, request: Request) -> bytes:
        """Locally, any file. On the demo: a visitor id, at most 10 MB read (and
        never more than one byte past it), a PDF of at most 20 pages, no page
        over 41 inches a side, three live uploads a visitor, and room on the
        shared disk. The old POST /api/sources calls this too."""
        if not demo.enabled():
            return await file.read()
        me = visitor.visitor_id(request)
        if me is None:
            raise HTTPException(400, sources.NO_VISITOR)
        # Refuse on the declared size before reading. The request's
        # Content-Length also counts the multipart framing, so it is the check
        # only when the file's own size is unknown.
        if file.size is not None and file.size > demo.MAX_UPLOAD_BYTES:
            raise sources._too_big(file.size)
        length = request.headers.get("content-length", "")
        if file.size is None and length.isdigit() and int(length) > demo.MAX_UPLOAD_BYTES:
            raise sources._too_big(None)
        data = await file.read(demo.MAX_UPLOAD_BYTES + 1)
        if len(data) > demo.MAX_UPLOAD_BYTES:
            raise sources._too_big(None)
        if not data:
            raise HTTPException(status_code=400, detail="empty upload")
        sources._check_demo_limits(request.app.state.deps.sources_dir, me, data)
        return data

    def on_uploaded(self, document: Document, request: Request) -> None:
        sources.record_upload(request.app.state.deps.sources_dir, document.sha, _visitor(request))

    def on_delete(self, sha: str, document: Document | None, request: Request) -> bool:
        """A sample is never deleted. On the demo only the caller's own upload:
        their id is dropped from the record, and the file goes once nobody else
        holds it. Locally, any upload."""
        if sha in sample_set.readable_shas():
            raise HTTPException(403, "A sample cannot be deleted. It is there for everyone.")
        me = visitor.visitor_id(request) if demo.enabled() else None
        if demo.enabled() and me is None:
            raise HTTPException(400, sources.NO_VISITOR)
        visitors = dict((document.extra.get("visitors") if document else None) or {})
        if document is None or (demo.enabled() and me not in visitors):
            raise HTTPException(404, "There is no upload of yours with that fingerprint.")
        if demo.enabled():
            visitors.pop(me, None)
            if visitors:
                body = {**document.record(), **document.extra, "visitors": visitors}
                sidecar = request.app.state.deps.sources_dir / META_DIR / f"{sha}.json"
                sidecar.write_text(json.dumps(body), encoding="utf-8")
                return False
        return True

    def describe(self, document: Document, request: Request) -> dict[str, Any]:
        """The upload time: this browser's own when it uploaded the file, else the latest."""
        listed = sources._listed({**document.record(), **document.extra}, _visitor(request))
        return {"uploaded_at": listed["uploaded_at"]} if "uploaded_at" in listed else {}

    def private(self, sha: str, request: Request) -> bool:
        """On the demo an upload is one browser's own: no shared cache may keep it.
        The old page route asks this too."""
        return demo.enabled() and sha not in sample_set.readable_shas()

    def keeps_question_sets(self, request: Request) -> bool:
        """The demo checks a set and hands the result back, but keeps nothing, so
        one visitor's questions never reach another's browser. The old
        POST /api/sources/{sha}/questions asks this too."""
        return not demo.enabled()

    # --- runs -------------------------------------------------------------------

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

    def max_variants(self, request: Request) -> int:
        """As many as one old sweep takes, in every mode, so the demo's bound on
        one request's work is the same on both stacks."""
        return MAX_VARIANTS

    def run_owner(self, request: Request) -> str | None:
        """On the demo a run is its visitor's own: to anyone else it is a 404.
        Locally anyone may follow or cancel it."""
        return _visitor(request) if demo.enabled() else None

    # --- the cache -----------------------------------------------------------------

    def check_clear_cache(self, request: Request) -> None:
        """One cache serves every visitor on the demo: clearing it would wipe
        everyone's results. The old DELETE /api/cache asks this too."""
        if demo.enabled():
            raise HTTPException(status_code=403, detail=NO_CLEARING)

    # --- keys ---------------------------------------------------------------------

    def server_key(self, provider: str) -> tuple[str | None, str]:
        """The environment, then `.env` at the repo root; on the demo, nothing:
        only a key the visitor typed is ever used."""
        return credentials.resolve_key(None, provider)

    # --- what leaves the server -----------------------------------------------------

    def scrub(self, text: str) -> str:
        """No server path leaves the server: the data folder, and any absolute
        path, keep only their last part. A run's keys are taken out before this
        (`pandion_api.credentials.redact`)."""
        return scrub_paths(text, self._data_dir)

    async def on_startup(self, app: FastAPI) -> None:
        """Put every sample's file in the store; on the demo, start expiring uploads."""
        self._data_dir = app.state.settings.data_dir
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
