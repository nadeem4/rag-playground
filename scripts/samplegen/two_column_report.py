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
#: The lowest a body line may sit; the footer lives below it.
BOTTOM = 70

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
        "Readers came from three colleges and were paid for an hour of their time. None had "
        "seen the documents before, and none was told what the study was about until it "
        "ended.",
        "Each session took about an hour. Readers could stop whenever they liked, but only "
        "four did, all of them on the longest documents.",
        "Nothing was printed. Everything was read on screen, one page at a time, because "
        "that is how most reports are read today.",
        "Before the study began, a pilot with twenty readers tested the questions and the "
        "timing. Two questions that nearly every reader got wrong were rewritten.",
        "The order of the documents was fixed so that every reader met the long ones after "
        "the short ones, once they were used to the screen.",
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
        "The extractor was the kind built into most PDF libraries. It reads the characters "
        "in the order they were drawn, which for these files was one row at a time across "
        "the page.",
        "The layout model looked at each page as a picture first. It found the blocks of "
        "text, put them in order, and only then read the characters inside them.",
        "Both programs ran on the same ordinary laptop, one after the other, with nothing "
        "else running.",
        "The test set was the same twelve documents, each in both layouts, for a total of "
        "twenty-four files and a little over a hundred pages.",
        "Every mistake was logged by hand, with the page, the line and the kind of error, "
        "so the two programs could be compared mistake by mistake.",
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
        "The second wave ran in the spring, at the same colleges, in the same rooms and on "
        "the same screens as the first.",
        "Readers who used two-column layouts at work were no faster with them than anyone "
        "else. Practice did not remove the cost of the jump between columns.",
        "The new documents were longer than the old ones by about a page each, which gave "
        "readers more chances to lose their place.",
        "As before, the time on each page was recorded, along with every jump back to an "
        "earlier line.",
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
        "This time the extractor was also tried on one-column pages. It made no mistakes on "
        "them at all.",
        "The layout model found every page number correctly, along with one line that was "
        "not a page number at all.",
        "Where the two programs disagreed, the authors' text settled it, as in the first "
        "study.",
        "The retrained model was given a hundred new pages to learn from, all of them "
        "reports with two columns.",
        "Its mistakes were fewer and smaller. Most were short lines at the foot of a page, "
        "read as footers when they were text.",
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
        "The product manual and the pension statement had the most tables. Neither table "
        "was asked about in the questions after each document.",
        "Reading time was rounded to the nearest second, and every average was taken over "
        "all readers, including the slow ones.",
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
        "Understanding was checked with three short questions after each document. Scores "
        "were the same for both layouts, so the faster reading on one column did not cost "
        "understanding.",
        "Several readers said they used a finger or the mouse pointer to keep their place "
        "on two columns. On one column almost nobody did.",
        "The study did not test very short pages, such as leaflets, where a reader can see "
        "the whole page at once.",
        "Readers also wrote a sentence about each document. Those who read on two columns "
        "were more likely to mention the layout, and nearly always to complain about it.",
        "None of this means two columns are always wrong. It means they have a cost, and "
        "the cost grows with the length of the text.",
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
        "Tables and captions were rare in the twelve documents, so they were left out of "
        "the comparison and counted separately.",
        "The authors' own text was the reference. A program scored a sentence as correct "
        "only when every word came out in the right order.",
        "On one-column pages the two programs agreed on every sentence, which is why the "
        "problem is easy to miss when a team tests only one kind of file.",
        "The plain extractor's mistakes were not random. They followed the rows of the "
        "page, so the same pair of columns was mixed on every line.",
        "A reader who sees such output knows at once that something is wrong. A search "
        "system does not know, and keeps the broken text as if it were right.",
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
        "Understanding scores were again the same for both layouts, as in the first wave.",
        "The rule between the columns was drawn in light grey, one point wide. Darker rules "
        "were tried in a pilot and readers found them distracting.",
        "Long paragraphs hurt two columns most. A paragraph that ran past the bottom of a "
        "column forced a jump in the middle of a thought.",
        "Readers on two columns also skipped more lines by accident, most often the first "
        "line at the top of the second column.",
        "The middle-ground layout cost more paper in print, because the wider gap left less "
        "room for text on each page.",
    ],
    [
        "The time each program took was also measured. The plain extractor read a page in "
        "a few hundredths of a second; the layout model took about two seconds a page on "
        "an ordinary laptop.",
        "For a search system the trade is clear. The fast extractor is fine for one column "
        "and wrong for two; the layout model costs time but keeps sentences whole.",
        "Some readers in the second wave used a screen reader. For them the layout made "
        "no difference at all, because the software read each column in turn.",
        "Running both programs on all twelve documents took the extractor under a second "
        "and the layout model about two minutes.",
        "A search system usually reads a document once and answers many questions about it, "
        "so the slower model's cost is paid once per document.",
        "For files that change every day, that cost is paid every day, and a team may keep "
        "the fast extractor for one-column files only.",
        "Neither program was tuned for these documents. Both were used exactly as they "
        "come.",
        "The fast extractor needed no training and no setup. That is its strength, and the "
        "reason it is the default in many tools.",
        "The layout model needed a download of a few hundred megabytes before the first "
        "page, and more memory while it ran.",
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
        "The full results for each document are kept by the study team and are not part of "
        "this summary.",
        "The study was not set up to test fonts, line length or colour, and those were kept "
        "the same in both layouts.",
        "A third wave is planned with people who read reports at work, to test whether the "
        "results hold beyond students.",
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
    if y < BOTTOM:
        raise ValueError(f"page {number}: the columns run into the footer (last line at y={y + LEADING})")
    if number == FOOTER_FACT_PAGE:
        page.text("F1", 8, LEFT_X, 40, FIELDWORK)
    page.text("F1", 9, PAGE_W - MARGIN - 40, 40, f"Page {number}")
    return page


def build() -> bytes:
    return Document([_page(LEFT[i], RIGHT[i], i + 1) for i in range(len(LEFT))]).build()
