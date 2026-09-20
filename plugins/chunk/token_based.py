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
from core.transform import Transform
from plugins.chunk import DocView, Span, build_chunk_set, normalize, token_spans


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
