"""Shared fixtures for plugin tests.

The PDF fixture is *generated*, never committed: a committed paper would be
someone else's copyright, and a generated one lets a test name the exact
sentences it expects the parser to recover.

The generator emits a minimal PDF 1.4 using the base-14 Helvetica font, so
nothing is embedded and the bytes are byte-for-byte identical on every run and
every machine. pypdfium2 can also *build* documents, but only with a font file
to embed — which would mean shipping a TTF to test a text extractor.
"""

from __future__ import annotations

from pathlib import Path

import pytest

#: The fixture document, page by page. A page is a list of lines; these exact
#: strings are what the parser must give back, in this order.
SAMPLE_PAGES: list[list[str]] = [
    [
        "The capital of France is Paris.",
        "Lyon is renowned for its cuisine.",
    ],
    [
        "Retrieval augmented generation grounds answers in documents.",
        "Chunking splits a document into passages.",
    ],
    [
        "The evaluation set contains twenty questions.",
        "Recall at ten is the headline metric.",
    ],
]

#: Every line of the document, flattened into reading order.
SAMPLE_LINES: list[str] = [line for page in SAMPLE_PAGES for line in page]


def _escape(line: str) -> bytes:
    return (
        line.replace("\\", "\\\\").replace("(", r"\(").replace(")", r"\)")
    ).encode("ascii")


def build_pdf(pages: list[list[str]]) -> bytes:
    """A minimal, deterministic PDF: one Helvetica text line per entry."""
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font_id = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    content_ids: list[int] = []
    for lines in pages:
        parts = [b"BT", b"/F1 12 Tf", b"16 TL", b"72 720 Td"]
        for line in lines:
            parts.append(b"(" + _escape(line) + b") Tj")
            parts.append(b"T*")
        parts.append(b"ET")
        stream = b"\n".join(parts)
        content_ids.append(
            add(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        )

    # The page objects must name their parent, which is allocated after them.
    pages_id = len(objects) + len(pages) + 1
    page_ids = [
        add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
            % (pages_id, font_id, cid)
        )
        for cid in content_ids
    ]
    assert add(
        b"<< /Type /Pages /Kids [%s] /Count %d >>"
        % (b" ".join(b"%d 0 R" % pid for pid in page_ids), len(page_ids))
    ) == pages_id
    catalog_id = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        catalog_id,
        xref,
    )
    return bytes(out)


@pytest.fixture
def sample_pdf(tmp_path: Path) -> Path:
    """A three-page PDF whose text is `SAMPLE_PAGES`."""
    path = tmp_path / "sample.pdf"
    path.write_bytes(build_pdf(SAMPLE_PAGES))
    return path
