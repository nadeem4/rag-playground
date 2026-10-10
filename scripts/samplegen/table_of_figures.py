"""`table-of-figures`: six pages of a small study, with its answers in tables, a chart and a scan.

pdfium flattens the cells into a word list in drawing order, so a value loses
its row label. docling with table structure on exports a markdown table, and a
row reads as a row. Size chunkers may cut the table between rows; the heading
chunker keeps it with its heading.

Page 3 holds a second table of twelve look-alike rows, page 4 a bar chart with a
caption, and page 5 is a picture of a page with no text layer (drawn the way
`scanned-notes` draws its pages), so its one fact is lost at Parse until OCR is
on. Two questions are planted to miss on the default pipeline, one per side; see
`samples/table-of-figures/sample.json`, `teaches`.
"""

from __future__ import annotations

from scripts.samplegen import scanned_notes
from scripts.samplegen.pdfwriter import Document, Page, PAGE_H, PAGE_W

NAME = "table-of-figures"
MARGIN = 72
TOP = 720
BOTTOM = 80
TITLE = ("F2", 18, 24, 60)
HEADING = ("F2", 13, 18, 70)
BODY = ("F1", 11, 15, 84)
CELL = ("F1", 10, 14, 30)
CELL_HEAD = ("F2", 10, 14, 30)
CAPTION = ("F2", 10, 14, 90)
COLS = [190, 90, 90, 98]
ROW_H = 22
ROW_H_SMALL = 19

ROWS: list[list[str]] = [
    ["Measure", "Before", "After", "Change"],
    ["Reading time per page", "84 s", "61 s", "-27%"],
    ["Readers who lost their place", "41", "16", "-61%"],
    ["Questions answered correctly", "72%", "88%", "+16 pts"],
    ["Pages reread at least once", "2.9", "1.4", "-52%"],
    ["Words per line", "13", "9", "-31%"],
    ["Satisfaction score", "6.1", "8.3", "+2.2"],
]

#: Table 2: twelve rows that differ only in the document's name and three numbers.
DOC_ROWS: list[list[str]] = [
    ["Document", "One column", "Two columns", "Difference"],
    ["Bus timetable guide", "40 s", "55 s", "+15 s"],
    ["Tenancy agreement", "92 s", "104 s", "+12 s"],
    ["Recipe booklet", "35 s", "37 s", "+2 s"],
    ["Council newsletter", "48 s", "47 s", "-1 s"],
    ["Pension statement", "71 s", "86 s", "+15 s"],
    ["Product manual", "66 s", "79 s", "+13 s"],
    ["Insurance policy", "88 s", "101 s", "+13 s"],
    ["School report", "44 s", "52 s", "+8 s"],
    ["Energy bill", "39 s", "46 s", "+7 s"],
    ["Train ticket terms", "57 s", "69 s", "+12 s"],
    ["Library leaflet", "33 s", "38 s", "+5 s"],
    ["Job advert", "41 s", "50 s", "+9 s"],
]

#: The chart's bars: each measure's change after the reset, in percent of its value before.
BARS: list[tuple[str, int]] = [
    ("Reading time", -27),
    ("Lost place", -61),
    ("Rereads", -52),
    ("Words per line", -31),
    ("Correct answers", 22),
    ("Satisfaction", 36),
]
FIGURE_CAPTION = "Figure 1. Change in each measure after the reset, as a percentage of the value before."

PAGE_1 = [
    (TITLE, "A small study of page layout"),
    (
        BODY,
        "Two hundred readers read the same twelve documents twice, once in the original "
        "layout and once after it was reset with a single column, wider margins and "
        "fewer words per line. Every measure below compares the two readings.",
    ),
    (
        BODY,
        "The two readings were a month apart, so that readers had forgotten most of each "
        "document, and half the readers met the reset layout first.",
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
    (
        BODY,
        "Every change in the table points the same way. No measure got worse after the "
        "reset, and none of the differences was close to the margin of error.",
    ),
    (
        BODY,
        "Words per line is the one measure the reset set directly. The others followed from "
        "it, which is why the study treats line length as the cause and the rest as effects.",
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
    (
        BODY,
        "Averages also hide who gained. Readers who read slowly to begin with gained the "
        "most from the reset; the fastest readers gained almost nothing, because they "
        "rarely lost their place in either layout.",
    ),
    (
        BODY,
        "The satisfaction score came from one question at the end of each document: how "
        "easy was this to read, from one to ten. It measures what readers felt, not what "
        "they did, and the two do not always agree.",
    ),
    (
        BODY,
        "Some changes interact. Fewer words per line means more lines per page and so more "
        "pages, and a reader who turns more pages has more chances to lose their place at "
        "the top of a new one. The reset still won, but by less than it would have without "
        "the extra pages.",
    ),
    (
        BODY,
        "Finally, a month between readings is long enough to forget details but not the "
        "gist. Some of the gain in correct answers may come from meeting the document a "
        "second time, which is why half the readers saw the reset layout first.",
    ),
    (
        BODY,
        "None of this undoes the result. It says how far the numbers can be trusted, and "
        "which questions the study cannot answer on its own.",
    ),
]
PAGE_3 = [
    (HEADING, "Results by document"),
    (
        BODY,
        "Table 2 gives the reading time per page for each of the twelve documents in both "
        "layouts. The difference is the extra time two columns cost, in seconds per page.",
    ),
]
PAGE_3_AFTER = [
    (
        BODY,
        "The council newsletter is the only row where two columns were not slower. Its "
        "stories were short and stood alone, so readers rarely had to jump between columns.",
    ),
    (
        BODY,
        "The rows look alike on purpose: same columns, same units, numbers in the same "
        "range. That is what most tables in real reports look like.",
    ),
    (
        BODY,
        "Longer documents cost more in two columns. The tenancy agreement and the insurance "
        "policy, the two longest, also had among the biggest differences once their length "
        "is taken into account.",
    ),
    (
        BODY,
        "The recipe booklet and the library leaflet were the shortest, and two columns cost "
        "them almost nothing.",
    ),
    (
        BODY,
        "A reader who wants one number from this table needs both the row label and the "
        "column heading. Lose either, and the number means nothing.",
    ),
]
PAGE_4 = [
    (HEADING, "The changes at a glance"),
    (
        BODY,
        "The chart below shows the same six measures as Table 1, each as a change from its "
        "value before the reset. Bars below the line are measures that fell; bars above "
        "it are measures that rose.",
    ),
]
PAGE_4_AFTER = [
    (
        BODY,
        "The chart makes the pattern easier to see than the table does: everything that "
        "costs a reader effort went down, and everything a reader gains went up.",
    ),
    (
        BODY,
        "A chart like this is a picture. A parser reads its caption and its labels as text, "
        "but the heights of the bars are only lines on the page, so the numbers behind them "
        "are lost unless they are also written down, as they are in Table 1.",
    ),
    (
        BODY,
        "That is why a question about the chart can only be answered from its caption, or "
        "from the table it was drawn from.",
    ),
    (
        BODY,
        "The two rising bars are the measures a reader would want to rise: answers that were "
        "right, and how easy the documents felt to read.",
    ),
    (
        BODY,
        "The four falling bars are all kinds of effort: time on the page, losing one's place, "
        "rereading, and the length of each line.",
    ),
]
#: Page 5 is an image only. Its one fact is not written anywhere else in the document.
SCANNED_PAGE = [
    "Summary for the board",
    "This page was printed, signed and scanned before the report was sent out, so it "
    "is a picture of a page with no text inside it.",
    "Across all twelve documents the single column saved an average of nine seconds a "
    "page, which over a report of forty pages is six minutes for every reader.",
    "The board approved the reset layout for every report the council publishes from "
    "next spring, and asked for the study to be repeated after a year.",
    "The study took four months from the first reader to this summary, and cost less "
    "than printing one annual report.",
    "Questions from the board about the method are answered in the notes at the end of "
    "the report.",
    "A copy of this summary, with the signatures, is kept with the minutes of the meeting "
    "that approved it.",
]
SCAN_FACT = "Across all twelve documents the single column saved an average of nine seconds a page"
PAGE_6 = [
    (HEADING, "Notes and caveats"),
    (
        BODY,
        "The readers were volunteers recruited through the council's newsletter, so they "
        "were people who already read council documents and may have been keener than most.",
    ),
    (
        BODY,
        "Each reading was timed by the screen software, not by a person with a stopwatch, "
        "so the times are exact to the second but include any pause a reader took.",
    ),
    (
        BODY,
        "The questions after each document were the same in both readings. A reader who "
        "remembered a question from the first reading may have looked for its answer in the "
        "second, which would favour whichever layout came second.",
    ),
    (
        BODY,
        "The twelve documents were chosen to be ordinary rather than difficult. Technical "
        "manuals and legal texts with dense cross-references were left for a later study.",
    ),
    (
        BODY,
        "Three readers did not finish the second reading and were left out entirely, rather "
        "than counted for the documents they did finish.",
    ),
    (
        BODY,
        "The printed copies used for the signed summary were set in the reset layout. The "
        "study itself was read entirely on screen.",
    ),
    (
        BODY,
        "All the figures in this report are rounded. A change shown as a quarter or a half "
        "is the nearest simple fraction to the measured value.",
    ),
    (
        BODY,
        "The reading times in Table 2 are averages over all two hundred readers. The spread "
        "within each document was about as wide as the spread described on page 2.",
    ),
    (
        BODY,
        "Satisfaction was asked once per document and reading, not once per page, so it "
        "cannot be compared with the times per page directly.",
    ),
    (
        BODY,
        "The study did not track eye movements. Where it says a reader lost their place, it "
        "means the screen software saw them scroll back up by more than three lines.",
    ),
    (
        BODY,
        "No reader saw the same document in the same layout twice.",
    ),
    (
        BODY,
        "The council paid for the study, but the analysis was done by an outside team who "
        "had no say in which layout was chosen.",
    ),
]


def _blocks(page: Page, blocks, y: float) -> float:
    for style, text in blocks:
        if style[0] == "F2" and y != TOP:
            y -= 8
        y = page.wrap(style, text, MARGIN, y)
        y -= 8
    return y


def _footer(page: Page, number: int, y: float) -> None:
    if y < BOTTOM:
        raise ValueError(f"page {number} runs into the footer (y={y})")
    page.text("F1", 9, PAGE_W - MARGIN - 40, 40, f"Page {number}")


def _chart(page: Page, top: float) -> float:
    """Six vertical bars around a zero line, one per measure, labels under the axis."""
    height = 220
    # The zero line sits two fifths down, so the largest fall (61%) and the largest
    # rise (36%) both stay inside the chart's box, above the labels.
    zero = top - height * 0.4
    scale = (height * 0.5) / 65
    slot = (PAGE_W - 2 * MARGIN) / len(BARS)
    page.rule(MARGIN, zero, PAGE_W - MARGIN, zero, 1)
    for i, (label, value) in enumerate(BARS):
        x = MARGIN + slot * i + slot / 2
        page.rule(x, zero, x, zero + value * scale, 26)
        sign = "+" if value > 0 else ""
        page.text("F1", 9, x - 12, zero + value * scale + (6 if value > 0 else -14), f"{sign}{value}%")
        page.text("F1", 8, x - 30, top - height - 6, label)
    return top - height - 24


def build() -> bytes:
    p1 = Page()
    y = _blocks(p1, PAGE_1, TOP)
    y = p1.wrap(CAPTION, "Table 1. Results of the study", MARGIN, y)
    y -= 6
    y = p1.cell_grid(MARGIN, y, COLS, ROW_H, ROWS, CELL, CELL_HEAD)
    y -= 16
    y = _blocks(p1, PAGE_1_AFTER, y)
    _footer(p1, 1, y)

    p2 = Page()
    _footer(p2, 2, _blocks(p2, PAGE_2, TOP))

    p3 = Page()
    y = _blocks(p3, PAGE_3, TOP)
    y = p3.wrap(CAPTION, "Table 2. Reading time per page for each document", MARGIN, y)
    y -= 6
    y = p3.cell_grid(MARGIN, y, COLS, ROW_H_SMALL, DOC_ROWS, CELL, CELL_HEAD)
    y -= 16
    _footer(p3, 3, _blocks(p3, PAGE_3_AFTER, y))

    p4 = Page()
    y = _blocks(p4, PAGE_4, TOP)
    y = _chart(p4, y - 10)
    y = p4.wrap(CAPTION, FIGURE_CAPTION, MARGIN, y)
    y -= 12
    _footer(p4, 4, _blocks(p4, PAGE_4_AFTER, y))

    p5 = Page()
    pixels = scanned_notes.render_page(SCANNED_PAGE, 5)
    p5.image("Im1", 0, 0, PAGE_W, PAGE_H, pixels, scanned_notes.W, scanned_notes.H)

    p6 = Page()
    _footer(p6, 6, _blocks(p6, PAGE_6, TOP))
    return Document([p1, p2, p3, p4, p5, p6]).build()
