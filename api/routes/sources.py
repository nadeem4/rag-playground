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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel

from api import demo, sample_set, visitor, warmup

router = APIRouter()

META_DIR = ".meta"


def owners(sources: Path, sha: str) -> dict[str, str]:
    """Visitor ids that uploaded this sha, each with its upload time. Empty for a sample."""
    meta = sources / META_DIR / f"{sha}.json"
    if not meta.is_file():
        return {}
    return dict(json.loads(meta.read_text(encoding="utf-8")).get("visitors") or {})


@router.get("/sources")
def list_sources(request: Request, response: Response) -> list[dict[str, Any]]:
    visitor.ensure_visitor(request, response)
    meta_dir = request.app.state.deps.sources_dir / META_DIR
    if not meta_dir.is_dir():
        return []
    items = [json.loads(p.read_text(encoding="utf-8")) for p in meta_dir.glob("*.json")]
    items = [m for m in items if demo.readable(m["sha"], request)]
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
    previous = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
    visitors = dict(previous.get("visitors") or {})
    if visitor:
        visitors[visitor] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stored = {**body, **({"visitors": visitors} if visitors else {})}
    meta_path.write_text(json.dumps(stored), encoding="utf-8")
    return body
