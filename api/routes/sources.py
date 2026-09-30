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


def live_uploads(sources: Path, me: str) -> int:
    meta_dir = sources / META_DIR
    if not meta_dir.is_dir():
        return 0
    return sum(1 for p in meta_dir.glob("*.json") if me in (json.loads(p.read_text(encoding="utf-8")).get("visitors") or {}))


def _fmt_mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB"


def _check_demo_limits(sources: Path, me: str, data: bytes) -> None:
    if len(data) > demo.MAX_UPLOAD_BYTES:
        raise HTTPException(
            413,
            f"This file is {_fmt_mb(len(data))}. The hosted demo takes files up to "
            f"{demo.MAX_UPLOAD_BYTES // (1024 * 1024)} MB. Run the playground locally for larger files.",
        )
    pages = page_count(data)
    if pages is None:
        raise HTTPException(415, "The hosted demo takes PDF files only.")
    if pages > demo.MAX_UPLOAD_PAGES:
        raise HTTPException(
            413,
            f"This PDF has {pages} pages. The hosted demo takes up to "
            f"{demo.MAX_UPLOAD_PAGES} pages. Run the playground locally for longer documents.",
        )
    sha = hashlib.sha256(data).hexdigest()
    if me not in owners(sources, sha) and live_uploads(sources, me) >= demo.MAX_UPLOADS_PER_VISITOR:
        raise HTTPException(
            429,
            f"This browser already has {demo.MAX_UPLOADS_PER_VISITOR} uploads. "
            f"Wait for one to expire, or run the playground locally.",
        )


@router.get("/sources")
def list_sources(request: Request, response: Response) -> list[dict[str, Any]]:
    visitor.ensure_visitor(request, response)
    meta_dir = request.app.state.deps.sources_dir / META_DIR
    if not meta_dir.is_dir():
        return []
    items = [_read_sidecar(p) for p in meta_dir.glob("*.json")]
    items = [m for m in items if m.get("sha") and demo.readable(m["sha"], request)]
    return sorted(
        ({k: v for k, v in m.items() if k != "visitors"} for m in items),
        key=lambda m: m["filename"].lower(),
    )


@router.post("/sources")
async def upload_source(request: Request, response: Response, file: UploadFile) -> dict[str, Any]:
    me = visitor.ensure_visitor(request, response)
    data = await file.read()
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
    previous = _read_sidecar(meta_path)
    visitors = dict(previous.get("visitors") or {})
    if visitor:
        visitors[visitor] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stored = {**body, **({"visitors": visitors} if visitors else {})}
    meta_path.write_text(json.dumps(stored), encoding="utf-8")
    return body
