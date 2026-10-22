"""Sentence windows: pieces are cut only where sentences end.

The rendered text is split into sentences with exact offsets, by the same
splitter sentence-id grounding uses, so a list item and a table row each count
as one sentence. A heading line is not a sentence of its own: it joins the
sentence after it (or, at the very end, the one before it), so a piece never
ends on a bare heading. A piece is `sentences_per_chunk` sentences in a
row, and the next piece starts `sentences_per_chunk - overlap_sentences`
sentences later, so every sentence lands in at least one piece and the last
piece may be shorter.
"""

from __future__ import annotations

from typing import Any, ClassVar, Mapping

from pydantic import Field, ValidationInfo, field_validator
from pydantic_core import PydanticCustomError

from pandion.artifacts import ArtifactType
from pandion.ids import AddedSettings
from pandion.payloads import ChunkSet
from pandion.ports import PortSpec, RunContext, Stage, set_note
from pandion.registry import register
from pandion.transform import Explanation, Transform
from pandion.plugins.chunk import (
    DocView,
    OVERLAP_ROLE,
    SIZE_ROLE,
    Span,
    add_heading_context,
    build_chunk_set,
    normalize,
)
from pandion.text import split_sentences

_OVERLAP_TOO_BIG = "Overlap must be smaller than the number of sentences per chunk."


class SentenceWindowConfig(AddedSettings):
    added: ClassVar[tuple[str, ...]] = ("heading_context",)

    sentences_per_chunk: int = Field(
        json_schema_extra=SIZE_ROLE,
        title="Sentences per piece",
        description="How many sentences go in each piece.",
        default=5,
        ge=1,
    )
    overlap_sentences: int = Field(
        json_schema_extra=OVERLAP_ROLE,
        title="Overlap",
        description="How many sentences each piece repeats from the one before.",
        default=1,
        ge=0,
    )
    #: Added after this chunker's results were first stored, and off by
    #: default, so those results keep their ids (pandion.ids.AddedSettings).
    heading_context: bool = Field(
        title="Heading in front",
        default=False,
        description=(
            "heading_context: when on, the heading path where a piece starts, "
            "for example Experience > a role, is put in front of the piece's "
            "text before it is turned into a vector. The piece that is shown "
            "and cited does not change. A document without headings is not "
            "affected."
        ),
    )

    @field_validator("overlap_sentences")
    @classmethod
    def _smaller_than_window(cls, value: int, info: ValidationInfo) -> int:
        # A field-level error, so the card shows it under the overlap field.
        size = info.data.get("sentences_per_chunk")
        if size is not None and value >= size:
            raise PydanticCustomError("overlap_too_big", _OVERLAP_TOO_BIG)
        return value


def _attach_headings(view: DocView, sentences: list[Span]) -> list[Span]:
    """Join each heading line to the sentence after it, as one unit.

    A heading is not a sentence of its own, so a piece never ends on a bare
    heading. Headings at the very end join the sentence before them.
    """
    headings = [e for e in view.rendered if e.type == "heading"]

    def is_heading(span: Span) -> bool:
        return any(h.md_start <= span[0] and span[1] <= h.md_end for h in headings)

    units: list[Span] = []
    pending: int | None = None  # start of the headings waiting for a sentence
    for span in sentences:
        if is_heading(span):
            pending = span[0] if pending is None else pending
            continue
        units.append((span[0] if pending is None else pending, span[1]))
        pending = None
    if pending is not None:
        if units:
            units[-1] = (units[-1][0], sentences[-1][1])
        else:
            units.append((pending, sentences[-1][1]))
    return units


def _windows(sentences: list[Span], size: int, overlap: int) -> list[Span]:
    """`size` sentences per window, each window `size - overlap` after the last."""
    windows: list[Span] = []
    step = size - overlap
    for i in range(0, len(sentences), step):
        group = sentences[i : i + size]
        windows.append((group[0][0], group[-1][1]))
        if i + size >= len(sentences):
            break
    return windows


def _count(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


@register
class SentenceWindowChunker(Transform[SentenceWindowConfig]):
    name = "sentence_window"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = SentenceWindowConfig
    summary = (
        "Cuts only where a sentence ends, so an answer sentence is never cut in "
        "half. Each piece is a fixed number of sentences in a row, and "
        "neighbouring pieces can share a few sentences. A heading line joins the "
        "sentence after it."
    )
    learn = {
        "_strategy": {
            "hint": "This strategy cuts the text only where a sentence ends.",
            "more": [
                "Each piece holds the same number of sentences, so a sentence is "
                "never cut in the middle. A list item and a table row each count "
                "as one sentence, and a heading line joins the sentence after it.",
                "The cost is that pieces vary in length, because sentences do. "
                "One long sentence makes one long piece.",
                "It works with any parser.",
            ],
        },
        "sentences_per_chunk": {
            "hint": "This is how many sentences go into each piece.",
            "more": [
                "More sentences give each piece more context, but one relevant "
                "sentence can then be drowned out by the rest of the piece.",
                "The last piece can hold fewer sentences.",
            ],
        },
        "overlap_sentences": {
            "hint": "This is how many sentences neighbouring pieces share.",
            "more": [
                "Sharing a sentence helps when an answer runs across the place "
                "where one piece ends and the next begins.",
                "The cost is more to store, and a search can return the same "
                "sentence twice. It must be smaller than the number of sentences "
                "per piece.",
            ],
        },
        "heading_context": {
            "hint": "When this is on, the heading path is added to what gets searched.",
            "more": [
                "The headings above the place where a piece starts are put in "
                "front of it before it is turned into a vector, for example "
                "Experience > a role. The piece itself, and what is shown and "
                "cited, does not change.",
                "This helps a question that names a section find the pieces in "
                "it. It needs a parser that finds headings. Without them, "
                "nothing is added.",
            ],
        },
    }

    def explain(self, config: SentenceWindowConfig) -> Explanation:
        size = config.sentences_per_chunk
        overlap = config.overlap_sentences
        shared = (
            "Pieces do not share sentences."
            if overlap == 0
            else f"Each piece shares {_count(overlap, 'sentence')} with the next one."
        )
        context = (
            " With heading_context on, the heading path where a piece starts "
            "is added in front of it when it is searched, so the section's "
            "name helps it match."
            if config.heading_context
            else ""
        )
        return Explanation(
            settings=(
                f"Every {_count(size, 'sentence')} in a row become one piece, and "
                f"a piece only ends where a sentence ends. {shared} A heading line "
                f"joins the sentence after it.{context}"
            ),
            tradeoff=(
                "An answer sentence is never cut in half, but pieces vary in "
                "length, and one long sentence makes one long piece."
                + (
                    " Shared sentences cost storage and can return the same "
                    "sentence twice."
                    if overlap
                    else ""
                )
            ),
        )

    def apply(
        self,
        inputs: Mapping[str, Any],
        config: SentenceWindowConfig,
        ctx: RunContext,
    ) -> ChunkSet:
        view = DocView.of(inputs["doc"])
        sentences = _attach_headings(
            view, normalize(view.text, split_sentences(view.text))
        )
        spans = (
            _windows(sentences, config.sentences_per_chunk, config.overlap_sentences)
            if sentences
            else []
        )
        chunk_set = build_chunk_set(
            view,
            spans,
            chunker=self.name,
            heading_paths=[view.heading_path_at(start) for start, _ in spans],
            meta={
                "sentences_per_chunk": config.sentences_per_chunk,
                "overlap_sentences": config.overlap_sentences,
                "sentences": len(sentences),
            },
        )
        if sentences:
            set_note(
                ctx,
                f"Cut {_count(len(sentences), 'sentence')} into "
                f"{_count(len(spans), 'piece')} of up to "
                f"{_count(config.sentences_per_chunk, 'sentence')}, "
                f"{config.overlap_sentences} shared between neighbours.",
            )
        if config.heading_context:
            add_heading_context(view, chunk_set)
        return chunk_set
