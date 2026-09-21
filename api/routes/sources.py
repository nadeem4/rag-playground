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
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, UploadFile

router = APIRouter()

META_DIR = ".meta"


@router.get("/sources")
def list_sources(request: Request) -> list[dict[str, Any]]:
    meta_dir = request.app.state.deps.sources_dir / META_DIR
    if not meta_dir.is_dir():
        return []
    items = [json.loads(p.read_text(encoding="utf-8")) for p in meta_dir.glob("*.json")]
    return sorted(items, key=lambda m: m["filename"].lower())


@router.post("/sources")
async def upload_source(request: Request, file: UploadFile) -> dict[str, Any]:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")

    sources: Path = request.app.state.deps.sources_dir
    filename = Path(file.filename or "upload").name
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
        "content_type": file.content_type
        or mimetypes.guess_type(filename)[0]
        or "application/octet-stream",
    }
    meta_dir = sources / META_DIR
    meta_dir.mkdir(exist_ok=True)
    (meta_dir / f"{sha}.json").write_text(json.dumps(body), encoding="utf-8")
    return body
