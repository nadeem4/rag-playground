"""A hand-written PDF writer: text, ruled cells and page images, no dependency.

Every sample in `samples/` is built with this so the bytes are the same on every
machine and every run. PDF 1.4, US Letter, Helvetica and Helvetica-Bold only.
"""

from __future__ import annotations

import textwrap

PAGE_W, PAGE_H = 612, 792

#: (font resource, size, leading, wrap width in characters)
Style = tuple[str, int, int, int]


def _escape(text: str) -> bytes:
    return text.replace("\\", "\\\\").replace("(", r"\(").replace(")", r"\)").encode("ascii")


class Page:
    def __init__(self) -> None:
        self._parts: list[bytes] = []
        self.images: list[tuple[str, int, int, bytes]] = []  # (resource name, width px, height px, zlib bytes)

    def text(self, font: str, size: int, x: float, y: float, string: str) -> None:
        self._parts.append(
            b"BT /%s %d Tf %d %d Td (%s) Tj ET" % (font.encode(), size, round(x), round(y), _escape(string))
        )

    def wrap(self, style: Style, text: str, x: float, y: float) -> float:
        """Lay out one block, return the y of the line after it."""
        font, size, leading, width = style
        for line in textwrap.wrap(text, width):
            self.text(font, size, x, y, line)
            y -= leading
        return y

    def stream(self) -> bytes:
        return b"\n".join(self._parts)


class Document:
    def __init__(self, pages: list[Page]) -> None:
        self.pages = pages

    def build(self) -> bytes:
        objects: list[bytes] = []

        def add(body: bytes) -> int:
            objects.append(body)
            return len(objects)

        regular = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        bold = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
        # First every page's images and content stream, in page order, so the
        # object numbering matches the old writer exactly when there are no
        # images (see the no-image branch in the page-dictionary loop below).
        page_specs: list[tuple[int, list[tuple[str, int]]]] = []
        for page in self.pages:
            xobjects: list[tuple[str, int]] = []
            for name, w, h, data in page.images:
                xid = add(
                    b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray "
                    b"/BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n%s\nendstream"
                    % (w, h, len(data), data)
                )
                xobjects.append((name, xid))
            s = page.stream()
            cid = add(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(s), s))
            page_specs.append((cid, xobjects))
        # Then every page object, then Pages, then Catalog.
        pages_id = len(objects) + len(page_specs) + 1
        page_ids = []
        for cid, xobjects in page_specs:
            # A page with no images keeps the old writer's `/Resources` exactly:
            # emitting an empty `/XObject << >>` for every page would change the
            # primer's bytes, so the key is left out entirely when there are none.
            if xobjects:
                xo = b"".join(b"/%s %d 0 R " % (n.encode(), i) for n, i in xobjects)
                res = b"<< /Font << /F1 %d 0 R /F2 %d 0 R >> /XObject << %s>> >>" % (regular, bold, xo)
            else:
                res = b"<< /Font << /F1 %d 0 R /F2 %d 0 R >> >>" % (regular, bold)
            page_ids.append(
                add(
                    b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources %s /Contents %d 0 R >>"
                    % (pages_id, PAGE_W, PAGE_H, res, cid)
                )
            )
        kids = b" ".join(b"%d 0 R" % pid for pid in page_ids)
        add(b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_ids)))
        catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

        out = bytearray(b"%PDF-1.4\n")
        offsets = []
        for n, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += b"%d 0 obj\n%s\nendobj\n" % (n, body)
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
        for offset in offsets:
            out += b"%010d 00000 n \n" % offset
        out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
            len(objects) + 1,
            catalog,
            xref,
        )
        return bytes(out)
