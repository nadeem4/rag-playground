"""Uploaded source files, content addressed exactly as the `upload` step resolves them.

The old /api/sources route stores a file as `<sha256><original suffix>`
(`pandion.sources.Sources`), the name the old run graph's upload step looks
for, so it keeps the raw suffix. /api/v2 stores through pandion-api's
`DocumentStore`, which keeps only a plain suffix and never stores the same
bytes twice. Both write the same record (`.meta/<sha>.json`: the original
filename, size and content type, and who uploaded it) under one lock, and both
refuse a name ending in `.part`.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from fastapi import APIRouter, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel

from pandion.sources import Sources

# The record helpers are pandion-api's, so both stacks share one record format
# and one lock (`SIDECAR_LOCK`, held here, in `expiry.sweep` and on /api/v2).
from pandion_api.documents import META_DIR, PART_REFUSED, SHA, SIDECAR_LOCK, DocumentStore, is_part
from pandion_api.documents import read_sidecar as _read_sidecar

from api import demo, sample_set, visitor, warmup

router = APIRouter()

NO_VISITOR = "This browser sent no visitor id. Open the demo in its own tab or enable cookies, then try again."
DEMO_FULL = "The demo is full right now. Try again later, or run the playground locally."


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


def oversized_page(data: bytes, limit: float) -> tuple[int, float, float] | None:
    """The first page with a side over `limit` points, as (page number, width, height), or None."""
    try:
        doc = pdfium.PdfDocument(data)
    except Exception:
        return None
    try:
        for i in range(len(doc)):
            width, height = doc.get_page_size(i)
            if max(width, height) > limit:
                return i + 1, width, height
        return None
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
    big = oversized_page(data, demo.MAX_PAGE_POINTS)
    if big is not None:
        number, width, height = big
        raise HTTPException(
            413,
            f"Page {number} is {round(width / 72)} by {round(height / 72)} inches. The hosted demo takes pages up to "
            f"{int(demo.MAX_PAGE_POINTS / 72)} inches a side. Run the playground locally for larger pages.",
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


def record_upload(sources: Path, sha: str, visitor: str | None) -> None:
    """After the record is written, with SIDECAR_LOCK held. A sample's bytes stay
    public under the sample's own name, with no owner, so the sweep never deletes
    the shared file and no cap counts it. An upload gains this visitor's upload
    time; the demo's 24 hours count from it."""
    meta_path = sources / META_DIR / f"{sha}.json"
    body = _read_sidecar(meta_path)
    sample = next((s for s in sample_set.all_samples() if s.sha == sha), None)
    if sample is not None:
        body["filename"], visitor = sample.pdf.name, None
    visitors = dict(body.get("visitors") or {})
    if visitor:
        visitors[visitor] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if visitors:
        body["visitors"] = visitors
    meta_path.write_text(json.dumps(body), encoding="utf-8")


@router.get("/sources")
def list_sources(request: Request, response: Response) -> list[dict[str, Any]]:
    visitor.ensure_visitor(request, response)
    # Per visitor, with upload times: no browser or proxy may keep a copy.
    response.headers["Cache-Control"] = "private, no-store"
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
    store = DocumentStore(sources)
    with SIDECAR_LOCK:
        if not request.app.state.policy.on_delete(sha, store.get(sha), request):
            return {"sha": sha, "deleted": False}
        store.remove(sha)
    return {"sha": sha, "deleted": True}


@router.post("/sources")
async def upload_source(request: Request, response: Response, file: UploadFile) -> dict[str, Any]:
    # Locally a first upload mints the visitor id; on the demo it never does:
    # a client that drops cookies would get a fresh id, and a fresh cap, each time.
    me = visitor.ensure_visitor(request, response) if not demo.enabled() else visitor.visitor_id(request)
    filename = Path(file.filename or "upload").name
    if is_part(filename):
        raise HTTPException(status_code=400, detail=PART_REFUSED)
    data = await request.app.state.policy.check_upload(file, request)
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    return _store(
        request.app.state.deps.sources_dir,
        filename,
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


def seed_sample_files(sources: Path) -> None:
    """Put every bundled sample's PDF in the store at startup. The Space's disk is
    not kept across a restart, and a pipeline saved on any sample must still find
    its file. Only the file: no record, so the list still shows a sample once a
    visitor loads it, as before."""
    sources.mkdir(parents=True, exist_ok=True)
    for sample in sample_set.all_samples():
        if not Sources(sources).path(sample.sha, sample.pdf.name).is_file():
            Sources(sources).add_bytes(sample.pdf.read_bytes(), sample.pdf.name)


def _store(
    sources: Path,
    filename: str,
    data: bytes,
    content_type: str | None,
    visitor: str | None = None,
) -> dict[str, Any]:
    sample = next((s for s in sample_set.all_samples() if s.sha == hashlib.sha256(data).hexdigest()), None)
    if sample is not None:
        filename = sample.pdf.name  # a sample's bytes are stored under the sample's own name
    # The raw suffix, as the old run graph's upload step looks for it.
    sha = Sources(sources).add_bytes(data, filename).sha
    store = DocumentStore(sources)
    ctype = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with SIDECAR_LOCK:
        store.write(sha, filename, len(data), ctype)
        record_upload(sources, sha, visitor)
    return store.get(sha).record()
