"""Documents: upload, fetch from a URL, list and delete, and a document's file
and pages, each as the site's Policy allows."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, UploadFile
from pandion.extend import FetchRefused, fetch_url
from pydantic import BaseModel, Field

from pandion_api.deps import get_documents, get_policy
from pandion_api.documents import NO_SUCH_DOCUMENT, PART_REFUSED, SHA, DocumentStore, is_part, unreadable
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
    refusal = unreadable(filename)
    if refusal:
        raise HTTPException(status_code=415, detail=refusal)
    data = await policy.check_upload(file, request)
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    content_type = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return keep(request, store, policy, data, filename, content_type)


def keep(
    request: Request,
    store: DocumentStore,
    policy: Policy,
    data: bytes,
    filename: str,
    content_type: str,
    origin_url: str | None = None,
) -> dict[str, Any]:
    """Judge the bytes (`Policy.check_document`), store them and write the
    record: one path for an upload and a URL document."""
    policy.check_document(data, filename, request)
    sha = store.save(data, filename)
    with store.lock:
        document = store.write(sha, filename, len(data), content_type, origin_url)
        policy.on_uploaded(document, request)
    return store.get(sha).record()


#: The status for each kind of fetch refusal, by the start of the guard's own
#: sentence (`pandion.extend.FetchRefused`). Anything else, such as a page that
#: answered 404 or could not be reached, is a 502.
FETCH_STATUS: tuple[tuple[str, int], ...] = (
    ("That address is not on the public internet", 403),
    ("Only https addresses", 403),
    ("A URL document must start with", 400),
    ("The URL's host name is not valid", 400),
    ("The page is larger than the limit", 413),
    ("Pandion reads HTML, PDF", 415),
    ("The URL took longer than", 504),
)

#: The longest URL the route takes.
MAX_URL_CHARS = 2000


class UrlDocument(BaseModel):
    url: str = Field(min_length=1, max_length=MAX_URL_CHARS)


def fetch_status(refusal: FetchRefused) -> int:
    said = str(refusal)
    return next((status for start, status in FETCH_STATUS if said.startswith(start)), 502)


@router.post("/documents/url")
def add_url_document(
    body: UrlDocument,
    request: Request,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    """Fetch one page (`pandion.extend.fetch_url`), then keep it like an upload,
    with the link in its record as `origin_url`. Every later route uses the
    stored id, so nothing is fetched again. A refusal is the guard's own
    sentence, which never repeats the URL or anything the page sent."""
    url = body.url.strip()
    policy.check_fetch(url, request)
    try:
        data, filename = fetch_url(
            url, public_only=policy.public_endpoints_only(request), max_bytes=policy.max_url_bytes(request)
        )
    except FetchRefused as refusal:
        raise HTTPException(status_code=fetch_status(refusal), detail=str(refusal)) from None
    refusal = unreadable(filename)
    if refusal:
        raise HTTPException(status_code=415, detail=refusal)
    if not data:
        raise HTTPException(status_code=400, detail="The page was empty, so there is nothing to keep.")
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return keep(request, store, policy, data, filename, content_type, origin_url=url)


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
