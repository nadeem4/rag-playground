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


#: Line pitch of the generated text, in points (the `TL` operator).
LEADING = 16


def _page_stream(paragraphs: list[list[str]], paragraph_gap: int) -> bytes:
    """One page's content stream: Helvetica 12 on a 16pt pitch.

    `paragraph_gap` extra points of vertical space go between paragraphs, which
    is the layout signal a paragraph-rebuilding parser reads. With a gap of 0
    the stream is byte-identical to the original one-list-of-lines generator.
    """
    parts = [b"BT", b"/F1 12 Tf", b"%d TL" % LEADING, b"72 720 Td"]
    for n, lines in enumerate(paragraphs):
        if n and paragraph_gap:
            parts.append(b"0 -%d Td" % paragraph_gap)
        for line in lines:
            parts.append(b"(" + _escape(line) + b") Tj")
            parts.append(b"T*")
    parts.append(b"ET")
    return b"\n".join(parts)


def build_pdf(pages: list[list[str]]) -> bytes:
    """A minimal, deterministic PDF: one Helvetica text line per entry.

    Every line sits on the same pitch, so there is no paragraph structure in
    the layout at all. Use `build_paragraph_pdf` when there should be.
    """
    return _assemble([_page_stream([lines], 0) for lines in pages])


def build_paragraph_pdf(
    pages: list[list[list[str]]], paragraph_gap: int = 12
) -> bytes:
    """Like `build_pdf`, but each page is a list of paragraphs, each a list of
    lines, laid out with `paragraph_gap` extra points between paragraphs.

    Real typesetting: lines inside a paragraph are one pitch apart, paragraphs
    are one pitch plus the gap apart.
    """
    return _assemble([_page_stream(paragraphs, paragraph_gap) for paragraphs in pages])


def _assemble(streams: list[bytes]) -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font_id = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    content_ids = [
        add(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        for stream in streams
    ]

    # The page objects must name their parent, which is allocated after them.
    pages_id = len(objects) + len(streams) + 1
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
