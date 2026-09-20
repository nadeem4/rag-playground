"""Plain text extraction with pypdfium2 — the deliberately dumb baseline.

**Licence, not preference.** PyMuPDF is the better extractor and is AGPL-3.0,
which is viral across a network boundary — serving this bench over HTTP would
oblige us to release under it. pdfium is Apache-2.0/BSD-3-Clause.

**It guesses nothing.** Every block comes out as a `paragraph`; there is no
heading detection, no table recovery, no reading-order repair on two-column
layouts. That is the point: Phase 3 puts a layout-aware parser beside this one
and the difference in downstream retrieval *is* the lesson. Teaching this
parser to guess would delete the comparison.

pdfium emits one line per visual line and effectively never a blank one, so the
block rule is a single split on any run of newlines: one element per extracted
line. Wrapped lines are therefore not re-joined — again, dumb on purpose, and it
leaves short repeated lines intact for `header_footer_strip` to find.
"""

from __future__ import annotations

import re
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


class PdfiumConfig(BaseModel):
    mode: Literal["text"] = "text"


@register
class PdfiumParse(Transform[PdfiumConfig]):
    """`raw_file -> parsed_doc`."""

    name = "pdfium"
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
                    text = textpage.get_text_range()
                finally:
                    textpage.close()
                    page.close()

                for block in _NEWLINES.split(text):
                    block = block.strip()
                    if not block:
                        continue
                    order = len(elements)
                    elements.append(
                        Element(
                            id=f"e{order:05d}",
                            type="paragraph",
                            text=block,
                            order=order,
                            page=index + 1,
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
