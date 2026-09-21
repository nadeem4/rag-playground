"""Plain text extraction with pypdfium2, the deliberately dumb baseline.

**Licence, not preference.** PyMuPDF is the better extractor and is AGPL-3.0,
which is viral across a network boundary: serving this bench over HTTP would
oblige us to release under it. pdfium is Apache-2.0/BSD-3-Clause.

**It guesses no structure.** Every block comes out as a `paragraph`; there is
no heading detection, no table recovery, no reading-order repair on two-column
layouts. That is the point: Phase 3 puts a layout-aware parser beside this one
and the difference in downstream retrieval *is* the lesson. Teaching this
parser to guess would delete the comparison.

**Lines versus paragraphs.** pdfium marks a break after every visual line and
never a paragraph break, so its text alone has no paragraphs in it.

- `join_lines=False` keeps one element per extracted line (version 1 output,
  byte for byte). Every line then renders as its own markdown block, which is
  why `recursive_character`'s paragraph-first separator finds nothing to do.
- `join_lines=True` (the default) rebuilds paragraphs from LAYOUT, not text:
  within a page, a line starts a new paragraph when its top sits more than
  `PARAGRAPH_GAP_RATIO` times the page's median line pitch below the previous
  line's top, or above it (a jump to a new column or region). Lines are
  measured with pdfium's loose char boxes, which span the font's full ascent
  and descent, so a line of `x`s and a line of `g`s have the same height.
  Pages are never merged across. A page with uniform spacing has no paragraph
  signal, so all of its lines join into one paragraph.

Short repeated lines (running heads, page numbers) survive the join as long as
the page sets them apart with a gap, as typesetting does, so
`header_footer_strip` still finds them.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping

import pypdfium2 as pdfium
from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import Element, ParsedDoc
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Transform

_NEWLINES = re.compile(r"[\r\n]+")
_LINE = re.compile(r"[^\r\n]+")
#: A letter, then a hyphen, at the end of a line: half of a broken word, if the
#: next line carries on in lowercase.
_BROKEN_WORD = re.compile(r"[^\W\d_]-$")
#: pdfium's marker for a hyphen it found at a line end, and what follows it.
_SOFT_HYPHEN = re.compile("￾(.?)")

#: A line pitch this many times the page median starts a new paragraph.
PARAGRAPH_GAP_RATIO = 1.5


class PdfiumConfig(BaseModel):
    mode: Literal["text"] = "text"
    #: Rebuild paragraphs from the vertical gaps between lines. False emits one
    #: element per extracted line, as version 1 did.
    join_lines: bool = True


@dataclass
class _Line:
    text: str
    #: (left, bottom, right, top) in PDF points, y growing upwards.
    bbox: tuple[float, float, float, float] | None


@register
class PdfiumParse(Transform[PdfiumConfig]):
    """`raw_file -> parsed_doc`."""

    name = "pdfium"
    version = "2"
    stage = Stage.PARSE
    inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
    output = ArtifactType.PARSED_DOC
    config_model = PdfiumConfig

    def apply(
        self, inputs: Mapping[str, Any], config: PdfiumConfig, ctx: RunContext
    ) -> dict[str, Any]:
        raw = inputs["file"]
        path = Path(raw["path"])

        # Hand pdfium the bytes, not the path: a document opened from a path
        # keeps a handle on it, and Windows will not let the store's commit
        # move or delete a directory underneath one.
        data = path.read_bytes()

        elements: list[Element] = []
        doc = pdfium.PdfDocument(data)
        try:
            page_count = len(doc)
            for index in range(page_count):
                page = doc[index]
                textpage = page.get_textpage()
                try:
                    if config.join_lines:
                        blocks = _paragraphs(_measured_lines(textpage))
                    else:
                        blocks = [
                            _Line(line.strip(), None)
                            for line in _NEWLINES.split(textpage.get_text_range())
                        ]
                finally:
                    textpage.close()
                    page.close()

                for block in blocks:
                    if not block.text:
                        continue
                    order = len(elements)
                    elements.append(
                        Element(
                            id=f"e{order:05d}",
                            type="paragraph",
                            text=block.text,
                            order=order,
                            page=index + 1,
                            bbox=block.bbox,
                        )
                    )
        finally:
            doc.close()

        return ParsedDoc(
            elements=elements,
            page_count=page_count,
            source_id=raw.get("sha", ""),
            filename=raw.get("filename", ""),
            parser_meta={"parser": self.name, "mode": config.mode},
        ).model_dump(mode="json")


def _measured_lines(textpage: Any) -> list[_Line]:
    """Every non-blank line of the page, with the box its glyphs occupy.

    pdfium's text is one UTF-16 unit per char index, generated line breaks
    included, so a position in the text is a char index. If that ever fails to
    hold, the page's lines come back unmeasured and are not joined.
    """
    text = textpage.get_text_range()
    aligned = len(text) == textpage.count_chars()
    lines: list[_Line] = []
    for match in _LINE.finditer(text):
        stripped = match.group().strip()
        if not stripped:
            continue
        bbox = None
        if aligned:
            boxes = [
                textpage.get_charbox(i, loose=True)
                for i in range(match.start(), match.end())
                if not text[i].isspace()
            ]
            bbox = (
                min(b[0] for b in boxes),
                min(b[1] for b in boxes),
                max(b[2] for b in boxes),
                max(b[3] for b in boxes),
            )
        lines.append(_Line(_resolve_soft_hyphens(stripped), bbox))
    return lines


def _resolve_soft_hyphens(text: str) -> str:
    """pdfium does part of the join itself: a line ending in letter-hyphen
    comes back glued to the next line, with the hyphen replaced by U+FFFE and
    no line break. Drop it before a lowercase continuation (a broken word);
    anywhere else restore the hyphen and the space the line break stood for.
    """
    def repair(match: re.Match[str]) -> str:
        after = match.group(1)
        if after.islower():
            return after
        return "- " + after if after else "-"

    return _SOFT_HYPHEN.sub(repair, text)


def _paragraphs(lines: list[_Line]) -> list[_Line]:
    """Merge consecutive lines unless the layout puts a paragraph gap between."""
    if any(line.bbox is None for line in lines):
        return lines
    pitches = [a.bbox[3] - b.bbox[3] for a, b in zip(lines, lines[1:])]
    positive = [p for p in pitches if p > 0]
    median = statistics.median(positive) if positive else 0.0

    paragraphs: list[_Line] = []
    for n, line in enumerate(lines):
        if n == 0 or _is_boundary(pitches[n - 1], median):
            paragraphs.append(_Line(line.text, line.bbox))
            continue
        current = paragraphs[-1]
        current.text = _join(current.text, line.text)
        current.bbox = (
            min(current.bbox[0], line.bbox[0]),
            min(current.bbox[1], line.bbox[1]),
            max(current.bbox[2], line.bbox[2]),
            max(current.bbox[3], line.bbox[3]),
        )
    return paragraphs


def _is_boundary(pitch: float, median: float) -> bool:
    # A line at or above the previous one is a new column or region.
    return pitch <= 0 or pitch > PARAGRAPH_GAP_RATIO * median


def _join(head: str, tail: str) -> str:
    """Join two lines with a space, repairing a word the line break split."""
    if _BROKEN_WORD.search(head) and tail[:1].islower():
        return head[:-1] + tail
    return head + " " + tail
