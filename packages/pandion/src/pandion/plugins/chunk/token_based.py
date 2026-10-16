"""Fixed token windows with a fixed stride — the chunker with a budget guarantee.

Embedding models and context windows are measured in tokens, not characters, so
this is the chunker to reach for when "no chunk may exceed N tokens" is a hard
constraint rather than a preference. It ignores document structure entirely,
which is exactly what makes it a useful control in a chunker bench.

Windows are cut on the boundaries `HeuristicTokenCounter` counts, so a chunk of
`max_tokens` tokens costs exactly `max_tokens` — never one more.
"""

from __future__ import annotations

from typing import Any, ClassVar, Mapping

from pydantic import Field

from pandion.artifacts import ArtifactType
from pandion.ids import AddedSettings
from pandion.payloads import ChunkSet
from pandion.ports import PortSpec, RunContext, Stage, set_note
from pandion.registry import register
from pandion.transform import Explanation, Transform
from pandion.plugins.chunk import (
    DocView,
    Span,
    add_heading_context,
    build_chunk_set,
    normalize,
    size_tradeoff,
    token_spans,
)


class TokenBasedConfig(AddedSettings):
    added: ClassVar[tuple[str, ...]] = ("heading_context",)

    max_tokens: int = Field(
        title="Piece size",
        description="The size of each piece, in tokens.",
        default=512,
        ge=1,
    )
    overlap: int = Field(
        title="Overlap",
        description="How many tokens each piece repeats from the end of the one before.",
        default=64,
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


@register
class TokenBasedChunker(Transform[TokenBasedConfig]):
    name = "token_based"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = TokenBasedConfig
    summary = (
        "Counts tokens and cuts each time the count is reached, wherever that "
        "falls. A token here is a word or a single punctuation mark. It ignores "
        "the structure of the text completely, which makes it a useful baseline "
        "to compare the other chunkers against."
    )
    learn = {
        "_strategy": {
            "hint": (
                "This strategy counts tokens and cuts every time the count reaches "
                "the limit, wherever that happens to be."
            ),
            "more": [
                "It ignores sentences, paragraphs and headings.",
                "That makes it a useful baseline. Compare it with the other "
                "strategies to see how much it helps to cut in natural places.",
            ],
        },
        "max_tokens": {
            "hint": "This is how many tokens go into each chunk.",
            "more": [
                "Here a token is one word or one punctuation mark.",
                "The cut happens exactly at this count, even in the middle of a "
                "sentence.",
            ],
        },
        "overlap": {
            "hint": (
                "This is how many tokens each chunk repeats from the end of the "
                "chunk before it."
            ),
            "more": [
                "If a sentence is cut at a border and it is shorter than the "
                "overlap, it appears whole at the start of the next chunk.",
                "The overlap must be smaller than the max tokens.",
            ],
        },
        "heading_context": {
            "hint": "When this is on, the heading path is added to what gets searched.",
            "more": [
                "The headings above the place where a chunk starts are put in "
                "front of it before it is turned into a vector, for example "
                "Experience > a role. The chunk itself, and what is shown and "
                "cited, does not change.",
                "This helps a question that names a section find the chunks in "
                "it. It needs a parser that finds headings. Without them, "
                "nothing is added.",
            ],
        },
    }

    def explain(self, config: TokenBasedConfig) -> Explanation:
        size, overlap = config.max_tokens, config.overlap
        if overlap >= size:
            # `apply` floors the stride at one token rather than failing.
            return Explanation(
                settings=(
                    f"The overlap ({overlap} tokens) is not smaller than max "
                    f"tokens ({size})."
                ),
                warning=(
                    "Overlap must be smaller than max tokens. At or above it, each "
                    "piece moves forward by a single token, so you would get "
                    "almost one piece per token of the document."
                ),
                blocking=True,
            )
        if overlap:
            repeat = (
                f"The last {overlap} tokens of each piece repeat at the start of "
                f"the next, so a sentence shorter than {overlap} tokens that is "
                "cut at a boundary still appears whole in one of them."
            )
        else:
            repeat = (
                "With no overlap, a sentence cut at a boundary is split between "
                "two pieces."
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
                f"Every piece is {size} tokens (the last may be shorter), cut "
                f"wherever the count lands, even mid-sentence or mid-table. {repeat}"
                f"{context}"
            ),
            tradeoff=size_tradeoff(size),
        )

    def apply(
        self,
        inputs: Mapping[str, Any],
        config: TokenBasedConfig,
        ctx: RunContext,
    ) -> ChunkSet:
        view = DocView.of(inputs["doc"])
        tokens = token_spans(view.text)

        # An overlap at or above the budget would mean no forward progress, so
        # the stride floors at one token rather than the config being rejected.
        stride = max(1, config.max_tokens - config.overlap)

        spans: list[Span] = []
        cursor = 0
        while cursor < len(tokens):
            window = tokens[cursor : cursor + config.max_tokens]
            spans.append((window[0][0], window[-1][1]))
            if cursor + config.max_tokens >= len(tokens):
                break
            cursor += stride

        chunk_set = build_chunk_set(
            view,
            normalize(view.text, spans),
            chunker=self.name,
            meta={"max_tokens": config.max_tokens, "overlap": config.overlap},
        )
        if config.heading_context and view.text:
            if not any(e.type == "heading" for e in view.rendered):
                set_note(
                    ctx,
                    "There are no headings in this document, so heading_context "
                    "adds nothing.",
                )
            add_heading_context(view, chunk_set)
        return chunk_set
