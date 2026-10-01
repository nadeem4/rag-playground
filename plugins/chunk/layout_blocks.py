"""Layout-aware chunking: pieces follow the page's own blocks.

The Layout parser finds headings, tables, captions and list items. This chunker
reads them in order and groups them in three steps.

- *Units.* A table and the caption right before or after it are one unit, and
  so are a figure and its caption. Every other block is a unit of its own.
- *Sections.* A new section starts at every heading that follows a body, as in
  `markdown_header`; headings in a row open one section together.
- *Pieces.* Units are packed in order up to `max_tokens`. A table unit that is
  too big stays whole when `keep_tables_whole` is on. Any other unit that is too
  big is cut at sentence ends, and only a single sentence that is itself too big
  is cut on token boundaries. A heading is never a piece on its own, except a
  last heading with nothing below it: it joins the piece below it, even when
  that piece is a table kept whole.

Every piece keeps its heading path. With `heading_context` on, the path is also
put in front of the piece in `embed_text`, so retrieval sees the section's name,
while `text` stays an exact slice of the source.
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
from plugins.use_case._sentences import split_sentences

#: Blocks a caption travels with.
_CAPTIONED = ("table", "figure")


class LayoutBlocksConfig(BaseModel):
    max_tokens: int = Field(default=400, ge=1)
    keep_tables_whole: bool = True
    heading_context: bool = True


def _units(elements: Sequence[Element]) -> list[list[Element]]:
    """Group a caption with the table or figure next to it.

    A caption before a table or figure binds to it first; a caption after one
    binds to it only when it is not itself followed by one, so a caption between
    two tables goes with the second.
    """
    units: list[list[Element]] = []
    i, n = 0, len(elements)

    def captioned(k: int) -> bool:
        return k < n and elements[k].type in _CAPTIONED

    while i < n:
        element = elements[i]
        if element.type == "caption" and captioned(i + 1):
            units.append([element, elements[i + 1]])
            i += 2
        elif element.type in _CAPTIONED:
            unit = [element]
            i += 1
            if i < n and elements[i].type == "caption" and not captioned(i + 1):
                unit.append(elements[i])
                i += 1
            units.append(unit)
        else:
            units.append([element])
            i += 1
    return units


def _sections(units: Sequence[list[Element]]) -> list[list[list[Element]]]:
    """Break the unit stream at every heading that follows a body.

    Headings in a row (a chapter, then its first section) open one section
    together, so they join the body below them.
    """
    sections: list[list[list[Element]]] = []
    current: list[list[Element]] = []
    for unit in units:
        if unit[0].type == "heading" and any(u[0].type != "heading" for u in current):
            sections.append(current)
            current = []
        current.append(unit)
    if current:
        sections.append(current)
    return sections


def _tokens(view: DocView, span: Span) -> int:
    return count_tokens(view.text[span[0] : span[1]])


def _sentence_atoms(view: DocView, span: Span, max_tokens: int) -> list[Span]:
    """Cut one oversized unit at sentence ends; a too-long sentence on tokens."""
    start, end = span
    atoms: list[Span] = []
    for s, e in split_sentences(view.text[start:end]):
        sentence = (start + s, start + e)
        if _tokens(view, sentence) <= max_tokens:
            atoms.append(sentence)
            continue
        tokens = token_spans(view.text, *sentence)
        atoms.extend(
            (group[0][0], group[-1][1])
            for group in (
                tokens[k : k + max_tokens] for k in range(0, len(tokens), max_tokens)
            )
        )
    return atoms or [span]


def _section_pieces(
    view: DocView,
    section: Sequence[list[Element]],
    config: LayoutBlocksConfig,
) -> list[Span]:
    """Pack a section's units into pieces of up to `max_tokens`."""
    pieces: list[Span] = []
    window: Span | None = None
    # True while the open window holds only a heading: a heading is never a
    # piece on its own, so whatever comes next joins it, however big.
    bare_heading = False

    def add(atom: Span, whole: bool = False) -> None:
        nonlocal window, bare_heading
        fits = (
            window is not None
            and _tokens(view, (window[0], atom[1])) <= config.max_tokens
        )
        if window is not None and (bare_heading or (fits and not whole)):
            window = (window[0], atom[1])
        else:
            if window is not None:
                pieces.append(window)
            window = atom
        bare_heading = False
        if whole:
            # Too big, but kept whole: nothing else joins this piece.
            pieces.append(window)
            window = None

    for unit in section:
        span = (unit[0].md_start, unit[-1].md_end)
        if unit[0].type == "heading":
            add(span)
            # Headings only open a section, so the window holds nothing else.
            bare_heading = True
        elif _tokens(view, span) <= config.max_tokens:
            add(span)
        elif config.keep_tables_whole and any(e.type == "table" for e in unit):
            add(span, whole=True)
        else:
            for atom in _sentence_atoms(view, span, config.max_tokens):
                add(atom)
    if window is not None:
        pieces.append(window)
    return pieces


def _path_of(view: DocView, span: Span) -> list[str]:
    """The heading path at the piece's last leading heading.

    A piece that opens with a chapter and then its section is about the
    section, so its path names both.
    """
    offset = span[0]
    for element in view.elements_in(*span):
        if element.type != "heading":
            break
        offset = element.md_start
    return view.heading_path_at(offset)


def _count(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


@register
class LayoutBlocksChunker(Transform[LayoutBlocksConfig]):
    name = "layout_blocks"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = LayoutBlocksConfig
    # Soft: without headings `apply` still runs and packs by size (see the
    # note it sets), so the UI shows this sentence before the run, not a lock.
    prefers = {"doc": {"structure": ["headings"]}}
    fallback = "There are no headings to follow, so the text is cut by size."
    summary = (
        "Cuts along the page's own blocks: headings, paragraphs, lists and "
        "tables. A table stays with its caption and its heading, and each "
        "section starts a new piece. Blocks are packed together up to the size "
        "limit, and a block is only cut when it is too long on its own."
    )
    learn = {
        "_strategy": {
            "hint": "This strategy follows the blocks the parser found on the page.",
            "more": [
                "A table and its caption stay together in one piece, and every "
                "piece keeps the headings above it. So a question about a table "
                "finds the table, its caption and the name of its section.",
                "The cost is that pieces vary in size, and a big table becomes one "
                "big piece.",
                "It needs a parser that finds headings and tables, such as the "
                "Layout parser. Without them, the text is only cut by size.",
            ],
        },
        "max_tokens": {
            "hint": "This is the largest a piece should be, counted in tokens.",
            "more": [
                "Here a token is one word or one punctuation mark.",
                "Blocks are packed into a piece until the next one would not fit. "
                "A block that is too long on its own is cut at the end of a "
                "sentence, never in the middle of one.",
                "A piece can run a little over this when a heading joins the "
                "block below it.",
            ],
        },
        "keep_tables_whole": {
            "hint": "When this is on, a table is never cut, even if it is too long.",
            "more": [
                "A table cut in half loses its column names in the second half, "
                "so its numbers no longer make sense. Keeping it whole avoids "
                "that, but the piece can be larger than the size limit.",
                "When this is off, a long table is cut between its rows.",
            ],
        },
        "heading_context": {
            "hint": "When this is on, the heading path is added to what gets searched.",
            "more": [
                "The headings above a piece are put in front of it before it is "
                "turned into a vector, for example Results > Scores. The piece "
                "itself, and what is shown and cited, does not change.",
                "This helps a question that names a section find the pieces in it.",
            ],
        },
    }

    def explain(self, config: LayoutBlocksConfig) -> Explanation:
        size = config.max_tokens
        tables = (
            "A table stays whole even when it is longer than that."
            if config.keep_tables_whole
            else "A table longer than that is cut between its rows."
        )
        context = (
            " The heading path is added in front of each piece when it is "
            "searched, so the section's name helps it match."
            if config.heading_context
            else ""
        )
        return Explanation(
            settings=(
                f"Blocks are packed into pieces of up to {size} tokens, and a new "
                "piece starts at every heading. A table keeps its caption. "
                f"{tables}{context} This needs a parser that finds headings and "
                "tables, such as the Layout parser."
            ),
            tradeoff=(
                "Pieces follow the page's own blocks, so a table comes back with "
                "its caption and its heading, but pieces vary in size, and a big "
                "table is one big piece."
            ),
        )

    def apply(
        self,
        inputs: Mapping[str, Any],
        config: LayoutBlocksConfig,
        ctx: RunContext,
    ) -> ChunkSet:
        view = DocView.of(inputs["doc"])
        units = _units(view.rendered)

        spans: list[Span] = []
        paths: list[list[str]] = []
        for section in _sections(units):
            for piece in _section_pieces(view, section, config):
                # Normalized one at a time so `paths` stays aligned with the
                # spans that actually survive.
                trimmed = normalize(view.text, [piece])
                if trimmed and (not spans or spans[-1] != trimmed[0]):
                    spans.append(trimmed[0])
                    paths.append(_path_of(view, trimmed[0]))

        headings = sum(1 for e in view.rendered if e.type == "heading")
        # Only the tables that were over the limit and kept whole anyway.
        tables_whole = (
            sum(
                1
                for unit in units
                if any(e.type == "table" for e in unit)
                and _tokens(view, (unit[0].md_start, unit[-1].md_end))
                > config.max_tokens
            )
            if config.keep_tables_whole
            else 0
        )

        chunk_set = build_chunk_set(
            view,
            spans,
            chunker=self.name,
            heading_paths=paths,
            meta={
                "max_tokens": config.max_tokens,
                "keep_tables_whole": config.keep_tables_whole,
                "heading_context": config.heading_context,
                "blocks": len(units),
                "headings": headings,
                "tables_kept_whole": tables_whole,
            },
        )
        if config.heading_context:
            for chunk in chunk_set.chunks:
                if chunk.heading_path:
                    chunk.embed_text = (
                        " > ".join(chunk.heading_path) + "\n\n" + chunk.text
                    )

        if view.rendered and not headings:
            set_note(ctx, self.fallback)
        elif view.rendered:
            set_note(
                ctx,
                f"Cut {_count(len(units), 'block')} into "
                f"{_count(len(spans), 'piece')} along "
                f"{_count(headings, 'heading')}, keeping "
                f"{_count(tables_whole, 'table')} whole.",
            )
        return chunk_set
