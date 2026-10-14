"""Documents: upload, list and delete, and a document's file and pages, each as
the site's Policy allows."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, UploadFile

from pandion_api.deps import get_documents, get_policy
from pandion_api.documents import NO_SUCH_DOCUMENT, PART_REFUSED, SHA, DocumentStore, is_part
from pandion_api.pages import (
    CACHE_CONTROL,
    MAX_FIND_CHARS,
    PRIVATE_CACHE_CONTROL,
    find,
    open_pdf,
    page_sizes,
    render_png,
)
from pandion_api.policy import Policy

router = APIRouter()


@router.get("/documents")
def list_documents(
    request: Request,
    response: Response,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> list[dict[str, Any]]:
    """The documents this request may read, by name. Never cached: the list
    can differ for each caller."""
    response.headers["Cache-Control"] = "private, no-store"
    shown = [
        {**d.record(), **policy.describe(d, request)}
        for d in store.all()
        if policy.can_read(d.sha, request)
    ]
    return sorted(shown, key=lambda d: d["filename"].lower())


@router.post("/documents")
async def upload_document(
    request: Request,
    file: UploadFile,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    # Only the name's last part, and only its suffix reaches a path: the
    # stored file is `<sha><suffix>`, whatever the request called it.
    filename = Path(file.filename or "upload").name
    if is_part(filename):
        raise HTTPException(status_code=400, detail=PART_REFUSED)
    data = await policy.check_upload(file, request)
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    content_type = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    sha = store.save(data, filename)
    with store.lock:
        document = store.write(sha, filename, len(data), content_type)
        policy.on_uploaded(document, request)
    return store.get(sha).record()


@router.delete("/documents/{sha}")
def delete_document(
    sha: str,
    request: Request,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    """Delete a document now, if the Policy agrees. `deleted` says whether the
    file left the disk: a Policy may keep it for someone else."""
    if not SHA.match(sha):
        raise HTTPException(status_code=404, detail=NO_SUCH_DOCUMENT)
    with store.lock:
        if not policy.on_delete(sha, store.get(sha), request):
            return {"sha": sha, "deleted": False}
        store.remove(sha)
    return {"sha": sha, "deleted": True}


def document_file(request: Request, sha: str) -> Path:
    """The stored file for `sha`: 404 when the id is malformed, the Policy says
    this request may not read it, or there is no such file. All three give the
    same answer, so a caller cannot tell another's document from a missing one."""
    policy: Policy = request.app.state.policy
    store: DocumentStore = request.app.state.documents
    if SHA.match(sha) and policy.can_read(sha, request):
        path = store.file(sha)
        if path is not None:
            return path
    raise HTTPException(status_code=404, detail=NO_SUCH_DOCUMENT)


@router.get("/documents/{sha}/file")
def document_bytes(sha: str, request: Request) -> Response:
    """The file's own bytes, read whole so no handle stays open. Never cached:
    a site may delete it, and a copy must not outlive it."""
    path = document_file(request, sha)
    media = "application/pdf" if path.suffix.lower() == ".pdf" else "application/octet-stream"
    return Response(path.read_bytes(), media_type=media, headers={"Cache-Control": "private, no-store"})


@router.get("/documents/{sha}/pages")
def list_pages(sha: str, request: Request) -> list[dict[str, Any]]:
    """Each page's size in PDF points."""
    with open_pdf(document_file(request, sha)) as doc:
        return page_sizes(doc)


@router.get("/documents/{sha}/pages/{n}")
def render_page(
    sha: str,
    n: int,
    request: Request,
    scale: float = Query(1.0, gt=0, le=8),
    policy: Policy = Depends(get_policy),
) -> Response:
    """A page as PNG. A render is a pure function of the bytes the id names, so
    it may be cached for a year, privately when the Policy says so."""
    with open_pdf(document_file(request, sha)) as doc:
        png = render_png(doc, n, scale)
    cache = PRIVATE_CACHE_CONTROL if policy.private(sha, request) else CACHE_CONTROL
    return Response(png, media_type="image/png", headers={"Cache-Control": cache})


@router.get("/documents/{sha}/pages/{n}/find")
def find_text(
    sha: str,
    n: int,
    request: Request,
    text: str = Query(..., min_length=1, max_length=MAX_FIND_CHARS),
) -> dict[str, Any]:
    """Where `text` is on page `n`, as rects in PDF points (left, bottom, right, top)."""
    with open_pdf(document_file(request, sha)) as doc:
        return find(doc, n, text)
