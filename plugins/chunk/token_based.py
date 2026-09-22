"""Fixed token windows with a fixed stride — the chunker with a budget guarantee.

Embedding models and context windows are measured in tokens, not characters, so
this is the chunker to reach for when "no chunk may exceed N tokens" is a hard
constraint rather than a preference. It ignores document structure entirely,
which is exactly what makes it a useful control in a chunker bench.

Windows are cut on the boundaries `HeuristicTokenCounter` counts, so a chunk of
`max_tokens` tokens costs exactly `max_tokens` — never one more.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import ChunkSet
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Explanation, Transform
from plugins.chunk import (
    DocView,
    Span,
    build_chunk_set,
    normalize,
    size_tradeoff,
    token_spans,
)


class TokenBasedConfig(BaseModel):
    max_tokens: int = Field(default=512, ge=1)
    overlap: int = Field(default=64, ge=0)


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
        return Explanation(
            settings=(
                f"Every piece is {size} tokens (the last may be shorter), cut "
                f"wherever the count lands, even mid-sentence or mid-table. {repeat}"
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

        return build_chunk_set(
            view,
            normalize(view.text, spans),
            chunker=self.name,
            meta={"max_tokens": config.max_tokens, "overlap": config.overlap},
        )
