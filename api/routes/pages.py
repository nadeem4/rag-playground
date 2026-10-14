"""PDF pages of an uploaded source: sizes, renders, and text search (spec §9).

The page helpers and the pdfium lock are pandion-api's (`pandion_api.pages`),
so the old routes and /api/v2 never use pdfium at the same moment. The module
note there says why a PDF is opened from its bytes and which way y grows.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pypdfium2 as pdfium
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pandion_api.pages import (
    CACHE_CONTROL,
    MAX_FIND_CHARS,
    PDFIUM_LOCK,
    PRIVATE_CACHE_CONTROL,
    find,
    open_pdf,
    page_sizes,
    render_png,
)

from api import demo
from api.routes.sources import SHA

router = APIRouter()

#: The one pdfium lock, named here too so a test can see both stacks hold it.
__all__ = ["PDFIUM_LOCK", "router", "source_path"]


def source_path(request: Request, sha: str) -> Path:
    """The stored file for this sha, or 404. Also the gold-set routes' guard."""
    sources: Path = request.app.state.deps.sources_dir
    if SHA.match(sha) and demo.readable(sha, request) and sources.is_dir():
        for p in sorted(sources.glob(f"{sha}*")):
            if p.is_file() and not p.name.endswith(".part"):
                return p
    raise HTTPException(status_code=404, detail=f"unknown source {sha}")


@contextmanager
def _open(request: Request, sha: str) -> Iterator[pdfium.PdfDocument]:
    with open_pdf(source_path(request, sha)) as doc:
        yield doc


@router.get("/sources/{sha}/file")
def source_file(sha: str, request: Request) -> Response:
    """The stored file's own bytes, so Library can export a saved item with its
    document. Read whole, so no handle stays open on the file. Never cached:
    the demo deletes an upload, and a copy must not outlive it."""
    path = source_path(request, sha)
    media = "application/pdf" if path.suffix.lower() == ".pdf" else "application/octet-stream"
    return Response(path.read_bytes(), media_type=media, headers={"Cache-Control": "private, no-store"})


@router.get("/sources/{sha}/pages")
def list_pages(sha: str, request: Request) -> list[dict[str, Any]]:
    with _open(request, sha) as doc:
        return page_sizes(doc)


@router.get("/sources/{sha}/pages/{n}.png")
def render_page(
    sha: str, n: int, request: Request, scale: float = Query(1.0, gt=0, le=8)
) -> Response:
    with _open(request, sha) as doc:
        png = render_png(doc, n, scale)
    private = request.app.state.policy.private(sha, request)
    return Response(
        png,
        media_type="image/png",
        headers={"Cache-Control": PRIVATE_CACHE_CONTROL if private else CACHE_CONTROL},
    )


@router.get("/sources/{sha}/pages/{n}/find")
def find_text(
    sha: str, n: int, request: Request, text: str = Query(..., min_length=1, max_length=MAX_FIND_CHARS)
) -> dict[str, Any]:
    with _open(request, sha) as doc:
        return find(doc, n, text)
