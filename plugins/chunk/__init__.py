"""Chunk-stage plugins, and the offset bookkeeping all of them share.

Every chunker here works the same way. It renders the `ParsedDoc` to markdown
**once**, decides on *spans* of that markdown, and never touches the text
itself. A chunk's `text` is therefore always a literal slice of
`ChunkSet.source_text`:

    chunk_set.source_text[chunk.start_char:chunk.end_char] == chunk.text

That invariant is not a nicety — the chunk-boundary overlay inspector is only
trustworthy because it holds. Keeping it is a structural property of this
module, not a discipline each chunker has to remember: a chunker returns spans
and `build_chunk_set` cuts the text, so there is no code path in which a chunker
*could* return text that does not slice back.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from core.ids import short_id
from core.payloads import Chunk, ChunkSet, Element, ParsedDoc
from providers.tokenize import HeuristicTokenCounter, TokenCounter

#: A half-open `[start, end)` range of `DocView.text`.
Span = tuple[int, int]

#: Mirrors the segmentation `HeuristicTokenCounter` counts with, so a span cut
#: on these boundaries costs exactly the number of tokens it contains. The two
#: must agree; the counter stays the single source of truth for `token_count`.
_TOKEN_RE = re.compile(r"\w+|[^\w\s]")

_COUNTER: TokenCounter = HeuristicTokenCounter()


def count_tokens(text: str) -> int:
    return _COUNTER.count(text)


def token_spans(text: str, start: int = 0, end: int | None = None) -> list[Span]:
    """Spans of every token in `text[start:end]`, in absolute coordinates."""
    end = len(text) if end is None else end
    return [(m.start(), m.end()) for m in _TOKEN_RE.finditer(text, start, end)]


@dataclass(frozen=True)
class DocView:
    """A parsed document plus its rendered projection, rendered once.

    `rendered` excludes elements that contribute nothing to the markdown —
    running heads, feet and page numbers, which `render_markdown` drops, and
    empty elements, which occupy no span and so can never be cited by a chunk
    without breaking the overlap claim `source_element_ids` makes.
    """

    doc: ParsedDoc
    text: str
    rendered: tuple[Element, ...]

    @classmethod
    def of(cls, payload: Any) -> DocView:
        """Accept either a `ParsedDoc` or the raw JSON the executor loads."""
        doc = (
            payload
            if isinstance(payload, ParsedDoc)
            else ParsedDoc.model_validate(payload)
        )
        text, _ = doc.render_markdown()
        rendered = tuple(
            e
            for e in sorted(doc.elements, key=lambda e: e.order)
            if e.md_start is not None and e.md_end is not None and e.md_end > e.md_start
        )
        return cls(doc=doc, text=text, rendered=rendered)

    @property
    def doc_id(self) -> str:
        return self.doc.source_id

    def elements_in(self, start: int, end: int) -> list[Element]:
        """Every rendered element whose own span intersects `[start, end)`."""
        return [e for e in self.rendered if e.md_start < end and e.md_end > start]

    def heading_path_at(self, offset: int) -> list[str]:
        """The heading stack in force at `offset`, outermost first.

        A heading that *begins* at `offset` counts: a chunk cut to start on a
        heading is a chunk about that heading.
        """
        stack: list[tuple[int, str]] = []
        for element in self.rendered:
            if element.md_start > offset:
                break
            if element.type != "heading":
                continue
            level = element.level or 1
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, element.text))
        return [text for _, text in stack]

    def page_span(self, elements: Sequence[Element]) -> tuple[int, int] | None:
        pages = [e.page for e in elements if e.page is not None]
        return (min(pages), max(pages)) if pages else None


def normalize(text: str, spans: Iterable[Span]) -> list[Span]:
    """Trim spans to their non-whitespace extent and drop the empty ones.

    Trimming keeps the invariant (a sub-span of a slice is still a slice) while
    keeping separator-only chunks — which cite no element and show nothing in
    the inspector — out of the output entirely.
    """
    out: list[Span] = []
    for start, end in spans:
        start, end = max(0, start), min(len(text), end)
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start < end and (not out or out[-1] != (start, end)):
            out.append((start, end))
    return out


def chunk_id(doc_id: str, chunker: str, ordinal: int, start: int, end: int) -> str:
    """Stable across runs, distinct across chunkers, span and order included."""
    key = f"{doc_id}\x00{chunker}\x00{ordinal}\x00{start}\x00{end}"
    return short_id(hashlib.sha256(key.encode("utf-8")).hexdigest())


def build_chunk_set(
    view: DocView,
    spans: Iterable[Span],
    *,
    chunker: str,
    heading_paths: Sequence[Sequence[str]] | None = None,
    meta: dict[str, Any] | None = None,
) -> ChunkSet:
    """Cut `view.text` at `spans` and attach every chunk's provenance.

    `heading_paths`, when given, must be parallel to `spans`; a chunker that
    already knows which section each span came from should pass it rather than
    let the path be re-derived from the offset.
    """
    spans = list(spans)
    chunks: list[Chunk] = []
    for ordinal, (start, end) in enumerate(spans):
        elements = view.elements_in(start, end)
        path = (
            list(heading_paths[ordinal])
            if heading_paths is not None
            else view.heading_path_at(start)
        )
        text = view.text[start:end]
        chunks.append(
            Chunk(
                id=chunk_id(view.doc_id, chunker, ordinal, start, end),
                text=text,
                start_char=start,
                end_char=end,
                token_count=count_tokens(text),
                ordinal=ordinal,
                doc_id=view.doc_id,
                heading_path=path,
                source_element_ids=[e.id for e in elements],
                page_span=view.page_span(elements),
            )
        )
    return ChunkSet(
        chunks=chunks,
        doc_id=view.doc_id,
        source_text=view.text,
        chunker_meta={"chunker": chunker, **(meta or {})},
    )
