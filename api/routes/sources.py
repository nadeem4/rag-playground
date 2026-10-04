"""Uploaded source files, content addressed exactly as `upload.py` resolves them.

The stored name is `<sha256><original suffix>`. The original filename, size and
content type live in a sidecar under `.meta/`, since the stored name alone
cannot give the filename back.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from fastapi import APIRouter, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel

from api import demo, sample_set, visitor, warmup

router = APIRouter()

META_DIR = ".meta"

#: A stored sha is always a sha256 hex digest. Checked before a sha reaches a
#: filesystem path, so a crafted value like `../../x` can never escape
#: `META_DIR` or the sources directory. Shared with `pages.py`.
SHA = re.compile(r"^[0-9a-f]{64}$")

#: Held around every sidecar read-modify-write, here and in `expiry.sweep`, so
#: two uploads of the same bytes, or an upload racing the sweep, never lose an owner.
SIDECAR_LOCK = threading.Lock()

NO_VISITOR = "This browser sent no visitor id. Open the demo in its own tab or enable cookies, then try again."
DEMO_FULL = "The demo is full right now. Try again later, or run the playground locally."


def _read_sidecar(path: Path) -> dict[str, Any]:
    """A sidecar's parsed JSON, or `{}` when it is missing, unreadable, or not an object."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def owners(sources: Path, sha: str) -> dict[str, str]:
    """Visitor ids that uploaded this sha, each with its upload time. Empty for a
    sample, an unknown sha, or a sha that is not a valid sha256 hex digest."""
    if not SHA.match(sha):
        return {}
    sidecar = _read_sidecar(sources / META_DIR / f"{sha}.json")
    return dict(sidecar.get("visitors") or {})


def page_count(data: bytes) -> int | None:
    """Pages in a PDF, or None when pdfium cannot open the bytes."""
    try:
        doc = pdfium.PdfDocument(data)
    except Exception:
        return None
    try:
        return len(doc)
    finally:
        doc.close()


def live_uploads(sources: Path, visitor: str) -> int:
    meta_dir = sources / META_DIR
    if not meta_dir.is_dir():
        return 0
    return sum(1 for p in meta_dir.glob("*.json") if visitor in (_read_sidecar(p).get("visitors") or {}))


def live_upload_bytes(sources: Path) -> int:
    """Bytes held by every live upload: sidecars with owners, by their stored size."""
    meta_dir = sources / META_DIR
    if not meta_dir.is_dir():
        return 0
    total = 0
    for p in meta_dir.glob("*.json"):
        body = _read_sidecar(p)
        size = body.get("size")
        if body.get("visitors") and isinstance(size, int):
            total += size
    return total


def _fmt_mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB"


def _too_big(size: int | None) -> HTTPException:
    """413 for a file over the cap, naming its size when the size is known."""
    cap = f"{demo.MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
    said = f"This file is {_fmt_mb(size)}." if size is not None else f"This file is more than {cap}."
    return HTTPException(
        413,
        f"{said} The hosted demo takes files up to {cap}. Run the playground locally for larger files. "
        "Or split out the pages you need and upload those.",
    )


def _check_demo_limits(sources: Path, me: str, data: bytes) -> None:
    pages = page_count(data)
    if pages is None:
        raise HTTPException(415, "The hosted demo takes PDF files only.")
    if pages > demo.MAX_UPLOAD_PAGES:
        raise HTTPException(
            413,
            f"This PDF has {pages} pages. The hosted demo takes up to "
            f"{demo.MAX_UPLOAD_PAGES} pages. Run the playground locally for longer documents. "
            "Or split out the pages you need and upload those.",
        )
    sha = hashlib.sha256(data).hexdigest()
    if sha in sample_set.readable_shas():
        return  # a sample's bytes store nothing new and stay public (see `_store`)
    current = owners(sources, sha)
    if me not in current and live_uploads(sources, me) >= demo.MAX_UPLOADS_PER_VISITOR:
        raise HTTPException(
            429,
            f"This browser already has {demo.MAX_UPLOADS_PER_VISITOR} uploads. "
            "Wait for one to expire, or run the playground locally.",
        )
    # bytes someone already uploaded take no more disk
    if not current and live_upload_bytes(sources) + len(data) > demo.MAX_TOTAL_UPLOAD_BYTES:
        raise HTTPException(503, DEMO_FULL)


@router.get("/sources")
def list_sources(request: Request, response: Response) -> list[dict[str, Any]]:
    visitor.ensure_visitor(request, response)
    meta_dir = request.app.state.deps.sources_dir / META_DIR
    if not meta_dir.is_dir():
        return []
    items = [_read_sidecar(p) for p in meta_dir.glob("*.json")]
    # a hand-edited sidecar without a string sha and filename is skipped, not a 500
    items = [
        m
        for m in items
        if isinstance(m.get("sha"), str)
        and isinstance(m.get("filename"), str)
        and demo.readable(m["sha"], request)
    ]
    me = visitor.visitor_id(request)
    return sorted((_listed(m, me) for m in items), key=lambda m: m["filename"].lower())


def _listed(meta: dict[str, Any], me: str | None) -> dict[str, Any]:
    """A sidecar as the list shows it: never the visitor ids, and `uploaded_at`
    when there is an upload time to give. That is this browser's own time when
    it uploaded the file (the demo's 24 hours count from it), else the latest
    one, so a local run still shows when a file arrived. A sample has none."""
    out = {k: v for k, v in meta.items() if k != "visitors"}
    stamps = meta.get("visitors") or {}
    if isinstance(stamps, dict) and stamps:
        mine = stamps.get(me) if me else None
        stamp = mine if isinstance(mine, str) else max((t for t in stamps.values() if isinstance(t, str)), default=None)
        if stamp:
            out["uploaded_at"] = stamp
    return out


@router.delete("/sources/{sha}")
def delete_source(sha: str, request: Request) -> dict[str, Any]:
    """Delete an upload now instead of when it expires.

    On the demo only the caller's own upload: their visitor id is dropped from
    the record, and the file goes once nobody else holds it. Running locally,
    any upload. A sample is never deleted. `deleted` says whether the file left
    the disk.
    """
    sources: Path = request.app.state.deps.sources_dir
    if not SHA.match(sha):
        raise HTTPException(404, "There is no upload with that fingerprint.")
    if sha in sample_set.readable_shas():
        raise HTTPException(403, "A sample cannot be deleted. It is there for everyone.")
    meta_path = sources / META_DIR / f"{sha}.json"
    me = visitor.visitor_id(request) if demo.enabled() else None
    if demo.enabled() and me is None:
        raise HTTPException(400, NO_VISITOR)
    with SIDECAR_LOCK:
        body = _read_sidecar(meta_path)
        visitors = dict(body.get("visitors") or {})
        if not body or (demo.enabled() and me not in visitors):
            raise HTTPException(404, "There is no upload of yours with that fingerprint.")
        if demo.enabled():
            visitors.pop(me, None)
            if visitors:
                meta_path.write_text(json.dumps({**body, "visitors": visitors}), encoding="utf-8")
                return {"sha": sha, "deleted": False}
        for f in sources.glob(f"{sha}*"):
            if f.is_file():
                f.unlink()
        meta_path.unlink(missing_ok=True)
    return {"sha": sha, "deleted": True}


@router.post("/sources")
async def upload_source(request: Request, response: Response, file: UploadFile) -> dict[str, Any]:
    if not demo.enabled():
        me = visitor.ensure_visitor(request, response)
        data = await file.read()
    else:
        # Never mint here: a client that drops cookies would get a fresh id, and
        # so a fresh upload cap, on every request.
        me = visitor.visitor_id(request)
        if me is None:
            raise HTTPException(400, NO_VISITOR)
        # Refuse on the declared size before reading, and never read more than
        # one byte past the cap, so a huge body never lands in memory. The
        # request's Content-Length also counts the multipart framing, so it is
        # the check only when the file's own size is unknown.
        if file.size is not None and file.size > demo.MAX_UPLOAD_BYTES:
            raise _too_big(file.size)
        length = request.headers.get("content-length", "")
        if file.size is None and length.isdigit() and int(length) > demo.MAX_UPLOAD_BYTES:
            raise _too_big(None)
        data = await file.read(demo.MAX_UPLOAD_BYTES + 1)
        if len(data) > demo.MAX_UPLOAD_BYTES:
            raise _too_big(None)
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    if demo.enabled():
        _check_demo_limits(request.app.state.deps.sources_dir, me, data)
    return _store(
        request.app.state.deps.sources_dir,
        Path(file.filename or "upload").name,
        data,
        file.content_type,
        visitor=me,
    )


class SampleRequest(BaseModel):
    name: str | None = None


@router.post("/sources/sample")
def sample_source(request: Request, body: SampleRequest | None = None) -> dict[str, Any]:
    """Register a bundled sample exactly like an upload (the default one when no
    name is given), and start warming up the models. The response never waits."""
    try:
        sample = sample_set.get_sample(body.name) if body and body.name else sample_set.default_sample()
    except KeyError:
        raise HTTPException(404, f"no sample named '{body.name}'") from None
    stored = _store(request.app.state.deps.sources_dir, sample.pdf.name, sample.pdf.read_bytes(), "application/pdf")
    warmup.start()
    return stored


def _store(
    sources: Path,
    filename: str,
    data: bytes,
    content_type: str | None,
    visitor: str | None = None,
) -> dict[str, Any]:
    sha = hashlib.sha256(data).hexdigest()
    sample = next((s for s in sample_set.all_samples() if s.sha == sha), None)
    if sample is not None:
        # A sample's bytes stay public under the sample's own name: no owner, so
        # the sweep never deletes the shared file and no cap counts it, and one
        # visitor's filename never renames the sample for everyone.
        filename, visitor = sample.pdf.name, None
    dest = sources / f"{sha}{Path(filename).suffix}"

    sources.mkdir(parents=True, exist_ok=True)
    if not dest.is_file():
        tmp = dest.with_name(dest.name + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, dest)

    body = {
        "sha": sha,
        "filename": filename,
        "size": len(data),
        "content_type": content_type
        or mimetypes.guess_type(filename)[0]
        or "application/octet-stream",
    }
    meta_dir = sources / META_DIR
    meta_dir.mkdir(exist_ok=True)
    meta_path = meta_dir / f"{sha}.json"
    with SIDECAR_LOCK:
        previous = _read_sidecar(meta_path)
        visitors = dict(previous.get("visitors") or {})
        if visitor:
            visitors[visitor] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        stored = {**body, **({"visitors": visitors} if visitors else {})}
        meta_path.write_text(json.dumps(stored), encoding="utf-8")
    return body
