"""The values that flow between stages.

**Elements are canonical; markdown is a rendered projection.** `ParsedDoc` stores
no markdown field. `render_markdown()` derives the text on demand and stamps each
element with the offsets at which its own rendered form appears.

That asymmetry is deliberate. Storing both views lets a cleaner strip a header
from one and not the other, silently desynchronising element-aware chunkers from
character-offset ones. Storing markdown *alone* irreversibly discards reading
order (fatal on two-column PDFs), merged table cells, and page boundaries.
Deriving one from the other removes the whole bug class: the projection cannot
drift from the elements, because it has no independent existence.

Everything here is plain Pydantic with a default on every optional field, so any
payload can be constructed empty, round-tripped through `core.storage`, and fed
to `core.ids.canonical_json` via `model_dump(mode="json")`.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

ElementType = Literal[
    "heading",
    "paragraph",
    "table",
    "list_item",
    "figure",
    "caption",
    "code",
    "header",
    "footer",
    "footnote",
    "formula",
    "page_number",
]

#: Running heads, running feet and page numbers are artefacts of pagination, not
#: of the document. They stay in `elements` (so `header_footer_strip` can report
#: on them and a reader can see what was found) but never reach the projection.
EXCLUDED_FROM_MARKDOWN: frozenset[str] = frozenset({"header", "footer", "page_number"})

#: Blocks are joined by a blank line — one separator, applied uniformly, so that
#: an element's span is always exactly its own rendered text.
BLOCK_SEPARATOR = "\n\n"


class Element(BaseModel):
    """One block of a parsed document, in explicit reading order."""

    id: str
    type: ElementType
    text: str
    order: int
    parent_id: str | None = None
    page: int | None = None
    bbox: tuple[float, float, float, float] | None = None
    level: int | None = None
    md_start: int | None = None
    md_end: int | None = None

    def render(self) -> str:
        """This element's markdown form. Excluded types render to nothing."""
        if self.type in EXCLUDED_FROM_MARKDOWN:
            return ""
        if self.type == "heading":
            return "#" * (self.level or 1) + " " + self.text
        if self.type == "list_item":
            return "- " + self.text
        if self.type == "code":
            return "```\n" + self.text + "\n```"
        # paragraph, table, figure, caption, footnote, formula: verbatim. Tables
        # are already markdown from the parser; re-rendering them would lose
        # alignment rows and merged cells.
        return self.text


class ParsedDoc(BaseModel):
    elements: list[Element]
    page_count: int = 0
    source_id: str = ""
    filename: str = ""
    doc_meta: dict = {}
    parser_meta: dict = {}

    def render_markdown(self) -> tuple[str, dict[str, tuple[int, int]]]:
        """Return `(markdown, {element_id: (start, end)})`.

        Also sets `md_start`/`md_end` on every element: the offsets for rendered
        ones, `None` for excluded ones. Offsets are always cleared first, so a
        re-render after a cleaner dropped elements leaves no stale spans behind,
        and calling this repeatedly is idempotent.

        Guaranteed: `markdown[e.md_start:e.md_end] == e.render()` for every
        element that appears in the returned mapping.
        """
        for element in self.elements:
            element.md_start = None
            element.md_end = None

        offsets: dict[str, tuple[int, int]] = {}
        parts: list[str] = []
        cursor = 0

        for element in sorted(self.elements, key=lambda e: e.order):
            if element.type in EXCLUDED_FROM_MARKDOWN:
                continue
            if parts:
                cursor += len(BLOCK_SEPARATOR)
            body = element.render()
            start, end = cursor, cursor + len(body)
            element.md_start, element.md_end = start, end
            offsets[element.id] = (start, end)
            parts.append(body)
            cursor = end

        return BLOCK_SEPARATOR.join(parts), offsets


class Chunk(BaseModel):
    id: str
    text: str
    embed_text: str | None = None
    start_char: int = 0
    end_char: int = 0
    token_count: int = 0
    kind: Literal["chunk", "summary", "proposition", "entity", "community"] = "chunk"
    parent_id: str | None = None
    level: int = 0
    ordinal: int = 0
    doc_id: str = ""
    heading_path: list[str] = []
    source_element_ids: list[str] = []
    page_span: tuple[int, int] | None = None
    metadata: dict = {}

    @property
    def text_to_embed(self) -> str:
        """What gets embedded, which is not always what gets shown.

        Contextual retrieval and proposition indexing retrieve on augmented text
        while citing the original. `None` — not falsiness — means "not set", so an
        intentionally empty `embed_text` is honoured.
        """
        return self.embed_text if self.embed_text is not None else self.text


class ChunkSet(BaseModel):
    chunks: list[Chunk] = []
    doc_id: str = ""
    #: The exact text the chunks were cut from, so `text[start_char:end_char]`
    #: stays verifiable and late chunking has something to re-embed against.
    source_text: str = ""
    chunker_meta: dict = {}


class Query(BaseModel):
    text: str = ""
    #: The sentence in the document that answers this question, when there is
    #: one (I-23). Empty means "not an evaluation question". It travels with the
    #: question so that sweeping the query node varies both together.
    gold_answer: str = ""
    variants: list[str] = []
    embed_text: str | None = None
    filters: dict | None = None
    history: list[dict] = []
    transform_trace: list[dict] = []


class Hit(BaseModel):
    chunk: Chunk
    score: float
    rank: int
    prior_rank: int | None = None
    prior_score: float | None = None
    matched_chunk_id: str = ""
    expansion: Literal["none", "parent", "window", "doc"] = "none"
    retriever: str = ""
    component_scores: dict[str, float] = {}
    highlights: list[tuple[int, int]] = []


class RetrievalResult(BaseModel):
    hits: list[Hit] = []
    query_id: str = ""
    fetch_k: int = 0
    total_candidates: int = 0
    timings_ms: dict[str, float] = {}


class Output(BaseModel):
    kind: str = ""
    payload: dict = {}


class QaItem(BaseModel):
    question: str
    gold_chunk_ids: list[str] = []
    gold_answer: str | None = None


class QaSet(BaseModel):
    items: list[QaItem] = []
