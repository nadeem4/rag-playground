"""Recursive character chunking: the baseline every other chunker is judged against.

Split on the most semantic boundary that works — paragraph, then line, then
sentence, then word — and only fall back to cutting mid-word when a run of text
offers no boundary at all. Then pack the resulting leaves into chunks up to
`chunk_size`, carrying `chunk_overlap` characters of tail into the next chunk.

Leaves are *spans*, never strings, and a chunk's span runs from its first leaf's
start to its last leaf's end — so the separators between leaves are inside the
chunk, and the chunk still slices back out of the source text exactly.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import ChunkSet
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Transform
from plugins.chunk import DocView, Span, build_chunk_set, normalize

#: `(separator, keep)` — `keep` is how many characters of the match stay with
#: the piece before it. A sentence keeps its full stop; whitespace separators
#: keep nothing, because trailing whitespace is noise in a displayed chunk.
_SEPARATORS: tuple[tuple[str, int], ...] = (
    ("\n\n", 0),
    ("\n", 0),
    (". ", 1),
    (" ", 0),
)


class RecursiveCharacterConfig(BaseModel):
    chunk_size: int = Field(default=1000, ge=1)
    chunk_overlap: int = Field(default=200, ge=0)


def _split_on(text: str, start: int, end: int, sep: str, keep: int) -> list[Span]:
    """Spans of `text[start:end]` between occurrences of `sep`."""
    spans: list[Span] = []
    pos = start
    while True:
        found = text.find(sep, pos, end)
        if found == -1:
            break
        piece_end = found + keep
        if piece_end > pos:
            spans.append((pos, piece_end))
        pos = found + len(sep)
    if pos < end:
        spans.append((pos, end))
    return spans


def _leaves(
    text: str,
    start: int,
    end: int,
    separators: tuple[tuple[str, int], ...],
    limit: int,
) -> list[Span]:
    """Spans no longer than `limit`, cut on the coarsest boundary that suffices."""
    if end - start <= limit:
        return [(start, end)] if end > start else []
    if not separators:
        # No boundary left anywhere in this run — a URL, a base64 blob, a
        # language that does not space its words. Cut on width.
        return [(i, min(i + limit, end)) for i in range(start, end, limit)]
    sep, keep = separators[0]
    pieces = _split_on(text, start, end, sep, keep)
    if len(pieces) < 2:
        return _leaves(text, start, end, separators[1:], limit)
    out: list[Span] = []
    for piece_start, piece_end in pieces:
        out.extend(_leaves(text, piece_start, piece_end, separators[1:], limit))
    return out


def _merge(leaves: list[Span], limit: int, overlap: int) -> list[Span]:
    """Pack leaves into chunks of at most `limit` characters, with overlap.

    After emitting, leaves are dropped from the front of the window until the
    retained tail fits in `overlap` *and* the incoming leaf fits in `limit`.
    The second condition is what guarantees progress: it fires exactly when the
    first did not, so the window's start always advances and the loop cannot
    emit the same span twice, even if `overlap >= limit`.
    """
    chunks: list[Span] = []
    window: list[Span] = []
    for leaf in leaves:
        if window and leaf[1] - window[0][0] > limit:
            chunks.append((window[0][0], window[-1][1]))
            while window and window[-1][1] - window[0][0] > overlap:
                window.pop(0)
            while window and leaf[1] - window[0][0] > limit:
                window.pop(0)
        window.append(leaf)
    if window:
        chunks.append((window[0][0], window[-1][1]))
    return chunks


@register
class RecursiveCharacterChunker(Transform[RecursiveCharacterConfig]):
    name = "recursive_character"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = RecursiveCharacterConfig

    def apply(
        self,
        inputs: Mapping[str, Any],
        config: RecursiveCharacterConfig,
        ctx: RunContext,
    ) -> ChunkSet:
        view = DocView.of(inputs["doc"])
        spans: list[Span] = []
        if view.text:
            overlap = min(config.chunk_overlap, config.chunk_size - 1)
            leaves = _leaves(
                view.text, 0, len(view.text), _SEPARATORS, config.chunk_size
            )
            spans = _merge(leaves, config.chunk_size, overlap)
        return build_chunk_set(
            view,
            normalize(view.text, spans),
            chunker=self.name,
            meta={
                "chunk_size": config.chunk_size,
                "chunk_overlap": config.chunk_overlap,
            },
        )
