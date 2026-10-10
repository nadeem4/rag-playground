"""`two-column-report`: five pages in two columns, drawn row by row, as many exporters do.

pdfium reads the rows across the page and joins the halves of different
sentences. docling's layout model reads each column in turn. Two questions have
gold passages that wrap inside the left column, so they miss under pdfium and
hit under docling.

Two more questions are planted to miss on the default pipeline, one per side:
the fieldwork fact lives only in page 3's footer, which Docling sets aside as
furniture (lost at Parse, found when the furniture layer is read), and one
question asks in other words about a sentence the search ranks low (see
`samples/two-column-report/sample.json`, `teaches`). Five pages give the default
chunker (400 characters) more than 20 pieces, so Evaluate's score means something.
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
HEADING = ("F2", 14)
BODY = ("F1", 10, 14, 44)      # 44 characters fits 234 points at 10 pt Helvetica
LEADING = 14

TITLE_TEXT = "Reading order in two-column reports"

#: The page titles: the report's title on page 1, a section heading where a section starts.
TITLES = {1: TITLE_TEXT, 3: "A second wave, one year later", 5: "Methods and limits"}

#: The one footer that carries a fact. The body never says it, so only a parse that
#: reads the furniture layer can answer the fieldwork question.
FIELDWORK = "Fieldwork by the Reading Lab between 3 March and 14 April 2026."
FOOTER_FACT_PAGE = 3

LEFT: list[list[str]] = [
    [
        "The survey ran for six weeks. Two hundred readers took part, and each read the "
        "same twelve documents in a fixed order. Half the documents were laid out in one "
        "column and half in two, so the layout was the only thing that changed.",
        "Readers were faster on one column. The average time per page fell by a fifth, "
        "and the number of readers who lost their place halfway down a page fell by "
        "more than half. Two columns looked tidier, but tidy is not the same as clear.",
        "Every reader saw the documents on the same screen, at the same size, in a quiet "
        "room. The study recorded the time spent on each page and every place where a "
        "reader went back to an earlier line.",
    ],
    [
        "The second study used the same documents. This time the readers were programs. "
        "A plain text extractor and a layout model each read every page, and their "
        "output was compared with the text the authors had written.",
        "The plain extractor did well on one column. On two columns it joined the halves "
        "of different sentences whenever a line of the left column sat at the same "
        "height as a line of the right, which on a full page is every line.",
        "Both programs were given the same files and no hints about the layout. Their "
        "output was saved as plain text and compared line by line with the original.",
    ],
    [
        "A year later the survey was run again with new readers. The second wave had one "
        "hundred and forty readers, and the documents were updated but kept the same "
        "length and the same mix of layouts.",
        "In the second wave the average time per page fell by a quarter on one column. "
        "The gap between the layouts was wider than in the first wave, mostly because the "
        "new documents had longer paragraphs.",
        "Losing their place was again the main cost of two columns. This time the readers "
        "who lost their place most often were the ones who read fastest.",
        "The second wave also asked readers to rate each document for clarity, from one to "
        "five. The one-column version scored higher on every document but one.",
    ],
    [
        "The programs were tested again on the updated documents. The plain extractor made "
        "the same mistake as before: on two columns it joined the halves of different "
        "sentences.",
        "The layout model was retrained between the waves. It no longer read a caption as "
        "a heading, but it still treated a short line at the foot of a page as a footer "
        "and left it out of the text.",
        "Neither program was told which pages had two columns. The layout model worked it "
        "out from where the lines sat on the page.",
    ],
    [
        "Each document was set in both layouts, and a coin toss decided which version a "
        "reader saw first. A reader never saw the same document twice in one session.",
        "Time per page was measured from the moment a page appeared to the moment the "
        "reader moved on. Pages a reader skipped were left out of the averages.",
        "The twelve documents covered ordinary reading: a bus timetable guide, a tenancy "
        "agreement, a recipe booklet, a council newsletter, a pension statement and a "
        "product manual among them.",
        "The bus timetable guide gained the most from one column: forty seconds a page "
        "against fifty-five on two. Its readers jumped between columns to match times "
        "with stops.",
        "The recipe booklet gained the least. Its short steps fitted inside one column "
        "either way, so readers rarely had to jump.",
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
        "Readers were also asked which layout they liked. Most chose one column, though a "
        "few said two columns felt more like a newspaper and were easier to skim.",
    ],
    [
        "The layout model made a different mistake. It sometimes read a caption as a "
        "heading, and once it read a footer as the last line. It never joined two "
        "columns into one line.",
        "For retrieval the difference is stark. A passage that was cut in half by a "
        "misread column is a passage no question can match, because the words that "
        "belong together are no longer next to each other.",
        "This matters well beyond this study. Search systems cut documents into pieces "
        "before they look for an answer, and a piece built from a misread page carries "
        "the mistake with it.",
    ],
    [
        "The second wave also tested a middle ground: two columns with a clear rule "
        "between them and a wider gap. It helped a little, but one column was still "
        "faster for every kind of document in the set.",
        "Headings made the biggest difference in the second wave. With a heading every "
        "few paragraphs, readers on two columns lost their place far less often, because "
        "a heading gave them somewhere to land.",
        "Only nine of the one hundred and forty readers asked to keep the two-column "
        "version when the study ended.",
    ],
    [
        "The time each program took was also measured. The plain extractor read a page in "
        "a few hundredths of a second; the layout model took about two seconds a page on "
        "an ordinary laptop.",
        "For a search system the trade is clear. The fast extractor is fine for one column "
        "and wrong for two; the layout model costs time but keeps sentences whole.",
        "Some readers in the second wave used a screen reader. For them the layout made "
        "no difference at all, because the software read each column in turn.",
    ],
    [
        "All the readers were students, so the results may not hold for people who read "
        "reports for a living.",
        "The documents were short reports of four to six pages. Longer documents might "
        "make the cost of two columns larger, because there are more column jumps.",
        "The tenancy agreement was the slowest document in both layouts. Readers went "
        "back to earlier clauses often, whatever the number of columns.",
        "The pension statement showed the widest spread between readers. Some read it in "
        "under a minute a page; others needed three, mostly to check figures twice.",
        "The council newsletter was the only document where two columns were not slower. "
        "Its stories were short and stood alone, like a newspaper.",
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
    title = TITLES.get(number)
    if title:
        font, size = (TITLE[0], TITLE[1]) if number == 1 else HEADING
        page.text(font, size, LEFT_X, 740, title)
    for l_line, r_line in itertools.zip_longest(_lines(left), _lines(right), fillvalue=""):
        if l_line:
            page.text(BODY[0], BODY[1], LEFT_X, y, l_line)
        if r_line:
            page.text(BODY[0], BODY[1], RIGHT_X, y, r_line)
        y -= LEADING
    if number == FOOTER_FACT_PAGE:
        page.text("F1", 8, LEFT_X, 40, FIELDWORK)
    page.text("F1", 9, PAGE_W - MARGIN - 40, 40, f"Page {number}")
    return page


def build() -> bytes:
    return Document([_page(LEFT[i], RIGHT[i], i + 1) for i in range(len(LEFT))]).build()
