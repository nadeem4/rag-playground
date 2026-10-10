"""`scanned-notes`: four pages that are pictures of text, with no text layer.

Every question is planted to miss without OCR (the parse finds no text at all)
and is found with OCR on; see `samples/scanned-notes/sample.json`, `teaches`.

Each page is prose rendered to a grayscale image with Pillow's bundled font and
embedded as the page's only content. pdfium reads nothing; docling with OCR on
reads it back. The prose is about scanning, so the sample explains itself.
"""

from __future__ import annotations

from PIL import Image, ImageDraw, ImageFont

from scripts.samplegen.pdfwriter import Document, Page, PAGE_H, PAGE_W

NAME = "scanned-notes"
DPI = 150
W, H = 1275, 1650        # US Letter at 150 dpi
MARGIN = 150
FONT_SIZE = 27
LEADING = 40
WRAP = 76                  # characters per line at this size

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
        "Most office scanners save to PDF by default, so a folder of scanned letters "
        "looks just like a folder of exported reports until someone tries to search it.",
        "The difference matters most for old records. Letters, contracts and minutes "
        "from before offices kept digital copies often exist only as scans.",
        "A scanned page can also be tilted. A sheet fed into the scanner at a slight angle "
        "gives lines of text that run downhill, and some OCR engines straighten them first "
        "while others do not.",
        "Colour scans are larger but not always better. For printed text, a clean black and "
        "white scan at three hundred dots per inch is usually the best input an OCR engine "
        "can get.",
        "Phone photos of a page are scans too. They add shadows and curved lines, and an "
        "OCR engine reads them worse than a flat scan of the same sheet.",
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
        "Some scanners run OCR themselves and hide the text behind the picture. Such a "
        "file looks scanned but parses like an exported one, which is why the parse, not "
        "the look of the page, is the test.",
        "The parse also tells you how much of a document is affected. A report where only "
        "the signed last page was scanned needs OCR for one page, not forty.",
        "A quick way to tell is to try to select a word on the page in a PDF viewer. Text "
        "in a text layer highlights; a picture of text does not.",
        "Some tools turn OCR on for every page as a safe default. It is safe, but it makes "
        "every document slow to read, and it can replace a perfect text layer with an "
        "imperfect guess.",
    ],
    [
        "What OCR gets wrong",
        "OCR reads shapes, so anything that changes a shape changes the reading. A smudge, "
        "a staple hole or a crease across a word can turn one letter into another.",
        "Numbers suffer most. Several digits look like letters to an engine that sees only "
        "shapes, and a wrong digit is harder to spot than a wrong letter.",
        "Layout suffers too. OCR on a page with two columns may read straight across them, "
        "just as a plain text extractor does, unless the engine first finds the columns.",
        "Tables are the hardest case. The engine sees the text in each cell but not always "
        "the lines between them, so rows can come back joined or split.",
        "Handwriting is mostly beyond a general OCR engine. Notes written in the margin are "
        "often left out, or read as noise.",
        "Stamps and signatures cause their own trouble. Ink that crosses printed text can "
        "hide the words beneath it, or add letters that were never there.",
        "Clean, high-contrast print is where OCR does best. On a crisp page of ordinary "
        "type, most engines get nearly every word right.",
        "Language matters as well. An engine set up for English struggles with accents, "
        "other alphabets and words it has never seen, and may turn a rare name into a "
        "common word.",
        "Faint print, such as the last copy from a tired printer, loses thin strokes first, "
        "and the letters with thin parts are the first to be misread.",
        "Most engines give each word a confidence score as they read it. A low score is a "
        "hint to check that word by eye before trusting it.",
    ],
    [
        "How to check a scan",
        "Start with a single page. Search the parsed text for a word you can see on the page; "
        "if the search finds nothing, the page has no text yet.",
        "Then turn OCR on and parse again. Compare a few lines of the output with the "
        "picture, and look hardest at numbers, names and anything in a table.",
        "Keep the OCR output, not just the answer it led to. When a question misses on a "
        "scanned document, the first place to look is what the engine read.",
        "If the scan is poor, scan it again before tuning anything. A cleaner picture at a "
        "higher resolution fixes more than any setting further down the pipeline.",
        "Finally, write down which documents were scanned. A collection that mixes scans "
        "and exports needs OCR on for some files and off for the rest.",
        "None of this is slow to do. Checking a scan takes a minute; finding out later "
        "that a whole folder was invisible takes much longer.",
        "It also helps to keep a few known questions for each scanned document, with the "
        "sentence that answers each one. Asking them after every change shows at once "
        "whether the text is still being read.",
        "When the answers stop coming back, the parse is the first suspect, not the search. "
        "A search cannot find a sentence that the engine never read.",
        "The care repays itself many times over, because a document is read once and "
        "searched for as long as it is kept.",
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
    if y > H - 135:
        raise ValueError(f"page {number}: the text runs into the page number (y={y})")
    draw.text((W - MARGIN - 120, H - 90), f"Page {number}", font=body, fill=96)
    return image.tobytes()


def build() -> bytes:
    pages = []
    for n, paragraphs in enumerate(PAGES, start=1):
        page = Page()
        page.image("Im1", 0, 0, PAGE_W, PAGE_H, render_page(paragraphs, n), W, H)
        pages.append(page)
    return Document(pages).build()
