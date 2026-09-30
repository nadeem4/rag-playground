"""`table-of-figures`: prose, a ruled table, prose. The answers live in cells.

pdfium flattens the cells into a word list in drawing order, so a value loses
its row label. docling with table structure on exports a markdown table, and a
row reads as a row. Size chunkers may cut the table between rows; the heading
chunker keeps it with its heading.
"""

from __future__ import annotations

from scripts.samplegen.pdfwriter import Document, Page, PAGE_W

NAME = "table-of-figures"
MARGIN = 72
TOP = 720
TITLE = ("F2", 18, 24, 60)
HEADING = ("F2", 13, 18, 70)
BODY = ("F1", 11, 15, 84)
CELL = ("F1", 10, 14, 30)
CELL_HEAD = ("F2", 10, 14, 30)
CAPTION = ("F2", 10, 14, 90)
COLS = [190, 90, 90, 98]
ROW_H = 22

ROWS: list[list[str]] = [
    ["Measure", "Before", "After", "Change"],
    ["Reading time per page", "84 s", "61 s", "-27%"],
    ["Readers who lost their place", "41", "16", "-61%"],
    ["Questions answered correctly", "72%", "88%", "+16 pts"],
    ["Pages reread at least once", "2.9", "1.4", "-52%"],
    ["Words per line", "13", "9", "-31%"],
    ["Satisfaction score", "6.1", "8.3", "+2.2"],
]

PAGE_1 = [
    (TITLE, "A small study of page layout"),
    (
        BODY,
        "Two hundred readers read the same twelve documents twice, once in the original "
        "layout and once after it was reset with a single column, wider margins and "
        "fewer words per line. Every measure below compares the two readings.",
    ),
    (HEADING, "Results"),
]
PAGE_1_AFTER = [
    (
        BODY,
        "The largest change was in readers who lost their place, which fell by more than "
        "half. Reading time per page fell by about a quarter. Satisfaction rose by two "
        "points on a ten point scale, the smallest change in relative terms and the one "
        "readers mentioned first when asked.",
    ),
]
PAGE_2 = [
    (HEADING, "What the numbers do not say"),
    (
        BODY,
        "The table reports averages. Behind the reading time of 61 seconds per page after "
        "the reset sits a wide spread: the fastest readers finished in half that, and the "
        "slowest took twice as long. The 88 percent of questions answered correctly hides "
        "that two of the twelve documents were answered no better than before.",
    ),
    (
        BODY,
        "A table is a good home for a number and a poor home for a caveat. When a passage "
        "is retrieved from this document, a row of the table carries its label and its "
        "values together only if the parser kept the row together. A parser that reads "
        "the cells as loose words leaves the number 61 with nothing to say what it "
        "measures.",
    ),
]


def _blocks(page: Page, blocks, y: float) -> float:
    for style, text in blocks:
        if style[0] == "F2" and y != TOP:
            y -= 8
        y = page.wrap(style, text, MARGIN, y)
        y -= 8
    return y


def build() -> bytes:
    p1 = Page()
    y = _blocks(p1, PAGE_1, TOP)
    y = p1.wrap(CAPTION, "Table 1. Results of the study", MARGIN, y)
    y -= 6
    y = p1.cell_grid(MARGIN, y, COLS, ROW_H, ROWS, CELL, CELL_HEAD)
    y -= 16
    _blocks(p1, PAGE_1_AFTER, y)
    p1.text("F1", 9, PAGE_W - MARGIN - 40, 40, "Page 1")
    p2 = Page()
    _blocks(p2, PAGE_2, TOP)
    p2.text("F1", 9, PAGE_W - MARGIN - 40, 40, "Page 2")
    return Document([p1, p2]).build()
