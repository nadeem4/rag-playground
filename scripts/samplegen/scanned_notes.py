"""`scanned-notes`: two pages that are pictures of text, with no text layer.

Each page is prose rendered to a grayscale image with Pillow's bundled font and
embedded as the page's only content. pdfium reads nothing; docling with OCR on
reads it back. The prose is about scanning, so the sample explains itself.
"""

from __future__ import annotations

from PIL import Image, ImageDraw, ImageFont

from scripts.samplegen.pdfwriter import Document, Page, PAGE_H, PAGE_W

NAME = "scanned-notes"
DPI = 100
W, H = 850, 1100          # US Letter at 100 dpi
MARGIN = 100
FONT_SIZE = 22
LEADING = 34
WRAP = 62                  # characters per line at this size

PAGES: list[list[str]] = [
    [
        "Notes on scanned documents",
        "A scanner does not read a page. It photographs it. The result is a grid of "
        "gray dots, and a PDF made from a scan is a container for those dots. There "
        "is no text inside such a file, only a picture of text.",
        "A text layer is the part of a PDF that holds real characters. When a document "
        "is exported from a word processor, every letter is stored as a letter, and a "
        "program can copy it, search it and count it. A scan has no such layer unless "
        "someone adds one afterwards.",
        "Optical character recognition, OCR for short, is the step that adds it. An OCR "
        "engine looks at the picture, guesses which shapes are letters, and writes the "
        "guesses back as text. The guesses are good on clean print and poor on faded ink.",
        "For retrieval this matters more than it seems. A retriever can only find text "
        "it was given. If the parse of a scanned page returns nothing, the page is "
        "invisible to every question, however relevant it is.",
    ],
    [
        "What to check first",
        "Before tuning anything else, open the parsed output and look for the page. An "
        "empty page in the parse means the file had no text layer for that page. Turning "
        "OCR on is the only fix; a better chunker cannot cut what is not there.",
        "OCR is slow. Reading text from an image takes seconds per page, where reading a "
        "text layer takes milliseconds. Leave OCR off for documents that already have "
        "text, and turn it on when the parse comes back empty.",
        "OCR is also imperfect. The letter l and the digit 1 are often confused, and a "
        "word split by a fold in the paper can come back as two words. A question that "
        "quotes a passage word for word may still miss when the passage was read by OCR.",
        "The habit to build is simple. Parse first, read the parse, and only then decide "
        "what the pipeline needs. A scanned page tells you within a second that it needs "
        "OCR, if you look.",
    ],
]


def render_page(paragraphs: list[str], number: int) -> bytes:
    """The page as 8 bit gray pixels, row-major, white paper and black ink."""
    import textwrap

    image = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(image)
    # Pillow picks the Raqm layout engine when it is available (the Linux
    # wheels CI runs on) and Basic otherwise (this machine). Raqm kerns
    # differently, which changes the pixels and so the zlib stream, and would
    # fail the byte-for-byte comparison against the committed PDF. Forcing
    # Basic here keeps the render identical on every platform.
    body = ImageFont.load_default(size=FONT_SIZE).font_variant(layout_engine=ImageFont.Layout.BASIC)
    title = ImageFont.load_default(size=FONT_SIZE + 10).font_variant(layout_engine=ImageFont.Layout.BASIC)
    y = MARGIN
    for i, paragraph in enumerate(paragraphs):
        font = title if i == 0 else body
        for line in textwrap.wrap(paragraph, WRAP if i else 40):
            draw.text((MARGIN, y), line, font=font, fill=0)
            y += LEADING + (8 if i == 0 else 0)
        y += LEADING // 2
    draw.text((W - MARGIN - 80, H - 60), f"Page {number}", font=body, fill=96)
    return image.tobytes()


def build() -> bytes:
    pages = []
    for n, paragraphs in enumerate(PAGES, start=1):
        page = Page()
        page.image("Im1", 0, 0, PAGE_W, PAGE_H, render_page(paragraphs, n), W, H)
        pages.append(page)
    return Document(pages).build()
