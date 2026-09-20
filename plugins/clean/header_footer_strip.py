"""Strip running heads, running feet and page numbers.

These are artefacts of *pagination*, not of the document. Left in, they land in
the middle of chunks, dilute every embedding with "ACME Corp — Confidential",
and answer questions about page 7 with the words "page 7".

Two detectors, both anchored to the first or last block of a page:

* **repetition** — the same short text at the same page edge on at least
  `min_page_ratio` of pages. Compared on normalized text with the digits left
  in, so `Section 1` … `Section 4` are four headings, not one running head.
* **page-number shape** — a block matching `3`, `Page 3`, `Page 3 of 9`, `- 3 -`
  at the same page edge on at least `min_page_ratio` of pages. Page numbers are
  the one running artefact that never repeats, so repetition alone cannot see
  them.

**Retype vs. drop.** Detected blocks are always retyped to `header` / `footer` /
`page_number`, and additionally removed from `elements` when `drop=True` (the
default). Retyping alone is already enough to keep them out of the text:
`core.payloads.EXCLUDED_FROM_MARKDOWN` holds exactly these three types, so a
retyped block renders to nothing and gets no offsets. `drop=False` is therefore
the inspectable mode — the blocks stay visible in the cleaning bench's element
list, greyed out, so a reader can check *what* was classified before trusting
the classifier. `drop=True` is the default because the bench's own report is the
audit trail, and a downstream element-aware chunker should not have to know
which element types are secretly invisible.

**Fixed point.** Removing the page number exposes whatever sat above it, which
may itself be a running foot. A single pass would leave that behind, and a
second application of the same cleaner would find it — breaking idempotence. So
the detector runs until a pass finds nothing, which makes the result a fixed
point by construction.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import EXCLUDED_FROM_MARKDOWN, Element
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Transform
from plugins.clean import apply_edits, as_parsed_doc, make_report, normalize, report_entry

#: A running head is short by definition. A repeated *paragraph* is boilerplate,
#: which is `dedupe_blocks`' job — conflating the two would let this plugin
#: delete a whole recurring licence clause on positional evidence alone.
MAX_RUNNING_CHARS = 120

#: `3`, `Page 3`, `Page 3 of 9`, `3 / 9`, `- 3 -`, `[3]`.
PAGE_NUMBER = re.compile(
    r"^[-–—\[(]?\s*(?:page\s*)?\d{1,4}\s*(?:(?:/|of|\|)\s*\d{1,4})?\s*[-–—\])]?$",
    re.IGNORECASE,
)

#: Which end of the page a block sits at. The tuple order is the precedence
#: order when one block is both (a page holding a single element).
POSITIONS: tuple[tuple[str, str], ...] = (("first", "header"), ("last", "footer"))


class HeaderFooterStripConfig(BaseModel):
    min_page_ratio: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description=(
            "Fraction of pages a block must appear on, at the same page edge, "
            "to count as a running artefact."
        ),
    )
    drop: bool = Field(
        default=True,
        description=(
            "Remove detected blocks from `elements`. When false they are only "
            "retyped, which already excludes them from the markdown projection "
            "while keeping them visible for inspection."
        ),
    )


def _is_page_number(text: str) -> bool:
    return bool(PAGE_NUMBER.match(text.strip()))


def _detect(
    elements: list[Element], min_page_ratio: float
) -> dict[str, tuple[str, str]]:
    """One pass: `{element_id: (new_type, reason)}` for this round's verdicts."""
    by_page: dict[int, list[Element]] = defaultdict(list)
    for element in elements:
        if element.page is not None:
            by_page[element.page].append(element)

    n_pages = len(by_page)
    # With a single page every block "appears on 100% of pages". The ratio is
    # meaningless there, and stripping on it would gut one-page documents.
    if n_pages < 2:
        return {}

    # Float-tolerant: 2 of 4 pages must satisfy a ratio of exactly 0.5.
    threshold = min_page_ratio * n_pages - 1e-9
    verdicts: dict[str, tuple[str, str]] = {}

    for position, repeat_type in POSITIONS:
        edge: dict[int, Element] = {}
        for page, page_elements in by_page.items():
            page_elements.sort(key=lambda e: e.order)
            edge[page] = page_elements[0 if position == "first" else -1]

        numbered = [e for e in edge.values() if _is_page_number(e.text)]
        if numbered and len(numbered) >= threshold:
            reason = (
                f"page-number shape in the {position} block of "
                f"{len(numbered)}/{n_pages} pages"
            )
            for element in numbered:
                verdicts.setdefault(element.id, ("page_number", reason))

        repeats: dict[str, list[Element]] = defaultdict(list)
        for element in edge.values():
            key = normalize(element.text)
            if key and len(key) <= MAX_RUNNING_CHARS:
                repeats[key].append(element)
        for group in repeats.values():
            if len(group) < threshold:
                continue
            reason = (
                f"repeated verbatim as the {position} block of "
                f"{len(group)}/{n_pages} pages"
            )
            for element in group:
                verdicts.setdefault(element.id, (repeat_type, reason))

    return verdicts


@register
class HeaderFooterStrip(Transform[HeaderFooterStripConfig]):
    name = "header_footer_strip"
    stage = Stage.CLEAN
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.PARSED_DOC
    config_model = HeaderFooterStripConfig

    def apply(
        self,
        inputs: Mapping[str, Any],
        config: HeaderFooterStripConfig,
        ctx: RunContext,
    ):
        doc = as_parsed_doc(inputs["doc"])

        verdicts: dict[str, tuple[str, str]] = {}
        while True:
            # A block already typed header/footer/page_number — by the input
            # parser, or by an earlier round of this loop — is settled. Skipping
            # it means the next round looks at the block *behind* it, which is
            # what makes `drop=False` a faithful preview of `drop=True`.
            live = [
                e
                for e in doc.elements
                if e.id not in verdicts and e.type not in EXCLUDED_FROM_MARKDOWN
            ]
            found = _detect(live, config.min_page_ratio)
            if not found:
                break
            verdicts.update(found)

        if not verdicts:
            return apply_edits(doc)

        retype = {eid: new_type for eid, (new_type, _) in verdicts.items()}
        rows = [
            (element, *verdicts[element.id])
            for element in sorted(doc.elements, key=lambda e: e.order)
            if element.id in verdicts
        ]

        if config.drop:
            removed = [
                report_entry(element, type=new_type, reason=reason)
                for element, new_type, reason in rows
            ]
            retyped: list[dict[str, Any]] = []
        else:
            removed = []
            retyped = [
                {
                    **report_entry(element),
                    "from": element.type,
                    "to": new_type,
                    "reason": reason,
                }
                for element, new_type, reason in rows
            ]

        report = make_report(
            self.name,
            self.version,
            config.model_dump(mode="json"),
            removed=removed,
            retyped=retyped,
            kept_count=len(doc.elements) - len(removed),
        )
        return apply_edits(
            doc,
            retype=retype,
            remove=set(retype) if config.drop else (),
            report=report,
        )
