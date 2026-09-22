"""PDF pages of an uploaded source: sizes, renders, and text search (spec §9).

Every request opens the PDF from **bytes**, never from its path, so pdfium holds
no handle on the file once the request ends; Windows would otherwise refuse to
replace or delete the source while it is open.

Coordinates are PDF points, (left, bottom, right, top) with y growing upwards:
the same convention as `Element.bbox`. The frontend scales them with the page
size from `/pages`.
"""

from __future__ import annotations

import io
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

from api import demo

router = APIRouter()

_SHA = re.compile(r"^[0-9a-f]{64}$")

#: A page render is a pure function of the source's bytes, which the sha names.
CACHE_CONTROL = "public, max-age=31536000, immutable"

#: Characters pdfium reports for a hyphen it decided was a soft line-end break.
_SOFT_HYPHENS = {"\x02", "\ufffe", "\u00ad"}


def _source_path(request: Request, sha: str) -> Path:
    sources: Path = request.app.state.deps.sources_dir
    if _SHA.match(sha) and demo.readable(sha) and sources.is_dir():
        for p in sorted(sources.glob(f"{sha}*")):
            if p.is_file() and not p.name.endswith(".part"):
                return p
    raise HTTPException(status_code=404, detail=f"unknown source {sha}")


@contextmanager
def _open(request: Request, sha: str) -> Iterator[pdfium.PdfDocument]:
    data = _source_path(request, sha).read_bytes()
    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        raise HTTPException(status_code=415, detail="source is not a PDF") from exc
    try:
        yield doc
    finally:
        doc.close()


def _page(doc: pdfium.PdfDocument, n: int) -> pdfium.PdfPage:
    if not 1 <= n <= len(doc):
        raise HTTPException(status_code=404, detail=f"no page {n}")
    return doc[n - 1]


@router.get("/sources/{sha}/pages")
def list_pages(sha: str, request: Request) -> list[dict[str, Any]]:
    with _open(request, sha) as doc:
        out = []
        for i in range(len(doc)):
            w, h = doc[i].get_size()
            out.append({"n": i + 1, "width": w, "height": h})
        return out


@router.get("/sources/{sha}/pages/{n}.png")
def render_page(
    sha: str, n: int, request: Request, scale: float = Query(1.0, gt=0, le=8)
) -> Response:
    with _open(request, sha) as doc:
        image = _page(doc, n).render(scale=scale).to_pil()
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(
        buf.getvalue(), media_type="image/png", headers={"Cache-Control": CACHE_CONTROL}
    )


def normalize(chars: list[str]) -> tuple[str, list[int]]:
    """Lower-case, collapse whitespace, and join line-end hyphenation.

    Returns the normalized text and, for each of its characters, the index of
    the source character it came from, so a match maps back to pdfium's char
    indices. Soft hyphens are dropped; a `-` followed by a line break (spaces
    allowed in between) is dropped together with that break, joining the word.
    Any run of whitespace becomes one space.
    """
    out: list[str] = []
    idx: list[int] = []
    i, n = 0, len(chars)
    while i < n:
        ch = chars[i]
        if ch in _SOFT_HYPHENS:
            i += 1
            continue
        if ch == "-":
            j = i + 1
            while j < n and chars[j] in " \t":
                j += 1
            if j < n and chars[j] in "\r\n":
                while j < n and chars[j].isspace():
                    j += 1
                i = j
                continue
        if ch.isspace():
            if out and out[-1] != " ":
                out.append(" ")
                idx.append(i)
            i += 1
            continue
        out.append(ch.lower())
        idx.append(i)
        i += 1
    while out and out[-1] == " ":
        out.pop()
        idx.pop()
    return "".join(out), idx


def _rects(textpage: pdfium.PdfTextPage, index: int, count: int) -> list[list[float]]:
    """pdfium merges a char range into one rect per line: (l, b, r, t)."""
    rects = []
    for k in range(textpage.count_rects(index, count)):
        l, b, r, t = textpage.get_rect(k)
        if r > l and t > b:
            rects.append([l, b, r, t])
    return rects


@router.get("/sources/{sha}/pages/{n}/find")
def find_text(
    sha: str, n: int, request: Request, text: str = Query(..., min_length=1)
) -> dict[str, Any]:
    with _open(request, sha) as doc:
        textpage = _page(doc, n).get_textpage()
        try:
            hit = textpage.search(text).get_next()
            if hit:
                return {"rects": _rects(textpage, *hit), "matched": "exact"}

            chars = [
                chr(pdfium_c.FPDFText_GetUnicode(textpage.raw, i))
                for i in range(textpage.count_chars())
            ]
            hay, idx = normalize(chars)
            needle, _ = normalize(list(text))
            at = hay.find(needle) if needle else -1
            if at < 0:
                return {"rects": [], "matched": "none"}
            start, end = idx[at], idx[at + len(needle) - 1] + 1
            return {"rects": _rects(textpage, start, end - start), "matched": "normalized"}
        finally:
            textpage.close()
