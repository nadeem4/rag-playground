"""`two-column-report`: two columns, drawn row by row, as many exporters do.

pdfium reads the rows across the page and joins the halves of different
sentences. docling's layout model reads each column in turn. Two questions have
gold passages that wrap inside the left column, so they miss under pdfium and
hit under docling; the others sit on a single line and hit under both.
"""

from __future__ import annotations

import itertools
import textwrap

from scripts.samplegen.pdfwriter import Document, Page, PAGE_W

NAME = "two-column-report"
MARGIN = 60
GUTTER = 24
COL_W = (PAGE_W - 2 * MARGIN - GUTTER) // 2       # 234 points
LEFT_X = MARGIN
RIGHT_X = MARGIN + COL_W + GUTTER
TOP = 700
TITLE = ("F2", 18, 24, 50)
BODY = ("F1", 10, 14, 44)      # 44 characters fits 234 points at 10 pt Helvetica
LEADING = 14

TITLE_TEXT = "Reading order in two-column reports"

LEFT: list[list[str]] = [
    [
        "The survey ran for six weeks. Two hundred readers took part, and each read the "
        "same twelve documents in a fixed order. Half the documents were laid out in one "
        "column and half in two, so the layout was the only thing that changed.",
        "Readers were faster on one column. The average time per page fell by a fifth, "
        "and the number of readers who lost their place halfway down a page fell by "
        "more than half. Two columns looked tidier, but tidy is not the same as clear.",
    ],
    [
        "The second study used the same documents. This time the readers were programs. "
        "A plain text extractor and a layout model each read every page, and their "
        "output was compared with the text the authors had written.",
        "The plain extractor did well on one column. On two columns it joined the halves "
        "of different sentences whenever a line of the left column sat at the same "
        "height as a line of the right, which on a full page is every line.",
    ],
]

RIGHT: list[list[str]] = [
    [
        "Errors followed the same pattern. When a reader lost the thread, the cause was "
        "almost always the jump from the bottom of one column to the top of the next, "
        "and never the text itself.",
        "The lesson for authors is modest. Use two columns when the page is short, and "
        "one when the argument is long. A reader who has to hunt for the next line has "
        "already stopped reading.",
    ],
    [
        "The layout model made a different mistake. It sometimes read a caption as a "
        "heading, and once it read a footer as the last line. It never joined two "
        "columns into one line.",
        "For retrieval the difference is stark. A passage that was cut in half by a "
        "misread column is a passage no question can match, because the words that "
        "belong together are no longer next to each other.",
    ],
]


def _lines(paragraphs: list[str]) -> list[str]:
    out: list[str] = []
    for p in paragraphs:
        out.extend(textwrap.wrap(p, BODY[3]))
        out.append("")          # a blank line between paragraphs
    return out


LEFT_SECOND_LINE_START = " ".join(_lines(LEFT[0])[1].split(" ")[:3])


def _page(left: list[str], right: list[str], number: int) -> Page:
    page = Page()
    y = TOP
    if number == 1:
        page.text(TITLE[0], TITLE[1], LEFT_X, 740, TITLE_TEXT)
    for l_line, r_line in itertools.zip_longest(_lines(left), _lines(right), fillvalue=""):
        if l_line:
            page.text(BODY[0], BODY[1], LEFT_X, y, l_line)
        if r_line:
            page.text(BODY[0], BODY[1], RIGHT_X, y, r_line)
        y -= LEADING
    page.text("F1", 9, PAGE_W - MARGIN - 40, 40, f"Page {number}")
    return page


def build() -> bytes:
    return Document([_page(LEFT[i], RIGHT[i], i + 1) for i in range(2)]).build()
