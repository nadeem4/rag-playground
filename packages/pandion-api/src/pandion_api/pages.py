"""PDF pages: sizes, renders and text search.

Every request opens the PDF from **bytes**, never from its path, so pdfium holds
no handle on the file once the request ends; Windows would otherwise refuse to
replace or delete the source while it is open.

Coordinates are PDF points, (left, bottom, right, top) with y growing upwards:
the same convention as `Element.bbox`. The frontend scales them with the page
size from `/pages`.
"""

from __future__ import annotations

import io
import math
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from fastapi import HTTPException

#: A page render is a pure function of the source's bytes, which the sha names.
CACHE_CONTROL = "public, max-age=31536000, immutable"
PRIVATE_CACHE_CONTROL = "private, max-age=31536000, immutable"

#: The largest page bitmap a render may allocate, and the smallest scale it clamps to.
MAX_PIXELS = 25_000_000
MIN_SCALE = 0.25

#: The longest text a find request may search for. A quote or a sentence is far
#: shorter; the cap keeps one request from holding PDFIUM_LOCK for long.
MAX_FIND_CHARS = 2000

#: pdfium is not thread-safe, and FastAPI runs these routes on a thread pool: a
#: document's Preview asks for every page at once, and two renders at the same
#: moment crash inside pdfium. One request uses pdfium at a time.
PDFIUM_LOCK = threading.Lock()

#: Characters pdfium reports for a hyphen it decided was a soft line-end break.
_SOFT_HYPHENS = {"\x02", "\ufffe", "\u00ad"}


@contextmanager
def open_pdf(path: Path) -> Iterator[pdfium.PdfDocument]:
    """The PDF at `path`, opened from its bytes (so no handle stays on the file),
    with PDFIUM_LOCK held. 415 when it is not a PDF."""
    data = path.read_bytes()
    with PDFIUM_LOCK:
        try:
            doc = pdfium.PdfDocument(data)
        except pdfium.PdfiumError as exc:
            raise HTTPException(status_code=415, detail="source is not a PDF") from exc
        try:
            yield doc
        finally:
            doc.close()


def page_of(doc: pdfium.PdfDocument, n: int) -> pdfium.PdfPage:
    if not 1 <= n <= len(doc):
        raise HTTPException(status_code=404, detail=f"no page {n}")
    return doc[n - 1]


def page_sizes(doc: pdfium.PdfDocument) -> list[dict[str, Any]]:
    """Each page's size in PDF points."""
    out = []
    for i in range(len(doc)):
        w, h = doc[i].get_size()
        out.append({"n": i + 1, "width": w, "height": h})
    return out


def render_png(doc: pdfium.PdfDocument, n: int, scale: float) -> bytes:
    page = page_of(doc, n)
    image = page.render(scale=clamp(scale, *page.get_size())).to_pil()
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def clamp(scale: float, width: float, height: float) -> float:
    """Lower the scale so the bitmap stays within MAX_PIXELS: an uploaded PDF
    can declare a page of any size, and scale 8 on a huge page would ask for
    gigabytes. Never below MIN_SCALE, unless even MIN_SCALE would break the
    cap: the cap always wins."""
    area = width * height
    if area <= 0:
        return scale
    cap = math.sqrt(MAX_PIXELS / area)
    return min(cap, max(MIN_SCALE, min(scale, cap)))


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


def rects(textpage: pdfium.PdfTextPage, index: int, count: int) -> list[list[float]]:
    """pdfium merges a char range into one rect per line: (l, b, r, t)."""
    out = []
    for k in range(textpage.count_rects(index, count)):
        l, b, r, t = textpage.get_rect(k)
        if r > l and t > b:
            out.append([l, b, r, t])
    return out


def find(doc: pdfium.PdfDocument, n: int, text: str) -> dict[str, Any]:
    """Where `text` is on page `n`: pdfium's own search first, then a search
    that ignores case, spacing and line-end hyphens."""
    textpage = page_of(doc, n).get_textpage()
    try:
        hit = textpage.search(text).get_next()
        if hit:
            return {"rects": rects(textpage, *hit), "matched": "exact"}
        chars = [chr(pdfium_c.FPDFText_GetUnicode(textpage.raw, i)) for i in range(textpage.count_chars())]
        hay, idx = normalize(chars)
        needle, _ = normalize(list(text))
        at = hay.find(needle) if needle else -1
        if at < 0:
            return {"rects": [], "matched": "none"}
        start, end = idx[at], idx[at + len(needle) - 1] + 1
        return {"rects": rects(textpage, start, end - start), "matched": "normalized"}
    finally:
        textpage.close()
