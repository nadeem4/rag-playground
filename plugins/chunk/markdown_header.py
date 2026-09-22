"""Heading-aware chunking: a section is a heading plus everything under it.

A heading and its body belong together — the heading is often the only thing in
the section that names what the body is about, and a chunk that loses it is a
chunk that cannot be retrieved. So every chunk starts at a heading (or at the
document's front matter) and carries the full `heading_path` down to it.

Sections are cut at *element* boundaries, so a section over budget is split
between blocks rather than through one. Only a single block that is itself over
budget is force-split, and then on token boundaries.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import ChunkSet, Element
from core.ports import PortSpec, RunContext, Stage, set_note
from core.registry import register
from core.transform import Explanation, Transform
from plugins.chunk import (
    DocView,
    Span,
    build_chunk_set,
    count_tokens,
    normalize,
    token_spans,
)


class MarkdownHeaderConfig(BaseModel):
    max_tokens: int = Field(default=512, ge=1)


def _sections(elements: Sequence[Element]) -> list[list[Element]]:
    """Break the element stream at every heading."""
    sections: list[list[Element]] = []
    current: list[Element] = []
    for element in elements:
        if element.type == "heading" and current:
            sections.append(current)
            current = []
        current.append(element)
    if current:
        sections.append(current)
    return sections


def _force_split(text: str, start: int, end: int, max_tokens: int) -> list[Span]:
    """Cut one oversized block on token boundaries."""
    tokens = token_spans(text, start, end)
    if not tokens:
        return [(start, end)]
    return [
        (group[0][0], group[-1][1])
        for group in (
            tokens[i : i + max_tokens] for i in range(0, len(tokens), max_tokens)
        )
    ]


def _section_spans(
    view: DocView, section: Sequence[Element], max_tokens: int
) -> list[Span]:
    whole = (section[0].md_start, section[-1].md_end)
    if count_tokens(view.text[whole[0] : whole[1]]) <= max_tokens:
        return [whole]

    spans: list[Span] = []
    window: list[Element] = []

    def flush() -> None:
        if window:
            spans.append((window[0].md_start, window[-1].md_end))
            window.clear()

    for element in section:
        if count_tokens(view.text[element.md_start : element.md_end]) > max_tokens:
            flush()
            spans.extend(
                _force_split(view.text, element.md_start, element.md_end, max_tokens)
            )
            continue
        grown = view.text[window[0].md_start : element.md_end] if window else ""
        if window and count_tokens(grown) > max_tokens:
            flush()
        window.append(element)
    flush()
    return spans


@register
class MarkdownHeaderChunker(Transform[MarkdownHeaderConfig]):
    name = "markdown_header"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = MarkdownHeaderConfig
    summary = (
        "Cuts at headings, so each piece is one section: a heading and "
        "everything under it, up to the next heading. A section too long for one "
        "piece is cut between its blocks, and only a single block that is itself "
        "too long is cut mid-text. Pieces do not overlap."
    )

    def explain(self, config: MarkdownHeaderConfig) -> Explanation:
        size = config.max_tokens
        return Explanation(
            settings=(
                f"A section of up to {size} tokens becomes one piece and keeps its "
                "heading path, for example Qualifications > Python. A longer "
                f"section is split between its paragraphs into pieces of up to "
                f"{size} tokens. This needs a parser that finds headings, such as "
                "docling; pdfium finds none, so with it the whole document is one "
                "section."
            ),
            tradeoff=(
                "Pieces follow the author's own structure, so each hit is a "
                "complete section, but sections vary in size, so some hits are "
                "long and some are short."
                + (
                    f" A limit of {size} tokens splits most sections, which loses "
                    "the one-section-per-piece benefit."
                    if size < 100
                    else ""
                )
            ),
        )

    def apply(
        self,
        inputs: Mapping[str, Any],
        config: MarkdownHeaderConfig,
        ctx: RunContext,
    ) -> ChunkSet:
        view = DocView.of(inputs["doc"])
        if view.rendered and not any(e.type == "heading" for e in view.rendered):
            # `_sections` then yields one section holding every block, which
            # `_section_spans` packs by size: the fallback, worth saying so.
            set_note(
                ctx,
                "The parser found no headings, so the whole document was treated "
                "as one section and packed into pieces of up to "
                f"{config.max_tokens} tokens.",
            )

        spans: list[Span] = []
        paths: list[list[str]] = []
        for section in _sections(view.rendered):
            # Derived once per section, from the section's own start: every
            # chunk split out of a section keeps the section's heading path.
            path = view.heading_path_at(section[0].md_start)
            for span in _section_spans(view, section, config.max_tokens):
                # Normalized one at a time so `paths` stays aligned with the
                # spans that actually survive.
                trimmed = normalize(view.text, [span])
                if trimmed and (not spans or spans[-1] != trimmed[0]):
                    spans.append(trimmed[0])
                    paths.append(path)

        return build_chunk_set(
            view,
            spans,
            chunker=self.name,
            heading_paths=paths,
            meta={"max_tokens": config.max_tokens},
        )
