"""A model-written context in front of each piece, before it is embedded.

A piece cut out of a document often does not say what it is about: "Revenue
grew 3%" names neither the company nor the quarter. For each piece, a chat
model reads the document and writes one short sentence that places the piece
in it, and that sentence goes in front of what is embedded. This is the
contextual retrieval recipe. The piece's `text`, id and offsets do not change,
so what is shown and cited stays an exact slice of the document; only
`embed_text` grows, on top of any heading path the chunker put there.

The index's `text` column holds what is embedded, so keyword search (BM25)
also sees the context, as in the published recipe.

The cost is one model call per piece. The document (`ChunkSet.source_text`,
the rendered text the chunker cut, up to `DOC_BUDGET` characters) opens every
call as the same prefix, sent for prompt caching, so after the first call most
of the input is a cache read. A short document is below the provider's caching
minimum (4,096 tokens for Claude Haiku 4.5), so each call then pays full input,
which is still small. The first call runs alone so it can write the cache; the
rest run `CONCURRENCY` at a time. The result is stored like any
other step's, so a second run with the same pieces and settings costs nothing.
Changing the piece settings makes new pieces, and pays again in full.

A failed call fails the step, naming the piece: half a set of contexts would
make pieces with and without context compete in one index.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from pandion import llm
from pandion.artifacts import ArtifactType
from pandion.endpoints import PUBLIC_ONLY_EXTRA
from pandion.llm import CHAT_MODELS
from pandion.payloads import ChunkSet
from pandion.ports import PortSpec, RunContext, Stage, set_note, set_usage
from pandion.registry import register
from pandion.transform import Explanation, Transform

#: The most of the document each call sends, in characters (about 10,000
#: tokens, or some 20 pages). A longer document is cut at this point.
DOC_BUDGET = 40_000

#: How many model calls run at once after the first.
CONCURRENCY = 6

#: The most pieces one run writes context for, unless max_pieces says otherwise.
MAX_PIECES = 200

#: Room for a reasoning model's thinking plus one short sentence.
MAX_TOKENS = 4096

SYSTEM_PROMPT = (
    "You help a search engine. You are given a document and one piece of it. "
    "Write one sentence of at most about 25 words that places the piece in the "
    "document: what the document is, which part the piece comes from, and what "
    "it is about, naming anything the piece leaves unsaid. Do not mention page "
    'numbers, do not use the words "this piece", do not repeat the piece and do '
    "not add facts that are not in the document. Reply with the sentence only."
)

#: Stop reasons that mean the reply was cut off at max_tokens.
_CUT_OFF = ("max_tokens", "length")

_SHOW_IF_CUSTOM = {"x-show-when": {"model": "custom"}}
_SHOW_IF_OPENROUTER = {"x-show-when": {"model": "openrouter"}}

#: A prompt is shown read-only in the playground's forms, as for chat.
_READ_ONLY = {"readOnly": True}


class LlmContextConfig(BaseModel):
    model: Literal[tuple(CHAT_MODELS)] = Field(  # type: ignore[valid-type]
        title="Model",
        default="claude-haiku-4-5",
        description="The chat model that writes each piece's context.",
        json_schema_extra=llm.MODEL_SCHEMA_EXTRA,
    )
    custom_base_url: str = Field(
        title="Endpoint URL",
        description="The address of an OpenAI-compatible server.",
        default="",
        json_schema_extra=_SHOW_IF_CUSTOM,
    )
    custom_model: str = Field(
        title="Model name",
        description="The model name that server expects.",
        default="",
        json_schema_extra=_SHOW_IF_CUSTOM,
    )
    openrouter_model: str = Field(
        default="",
        title="OpenRouter model",
        description=llm.OPENROUTER_MODEL_HELP,
        json_schema_extra=_SHOW_IF_OPENROUTER,
    )
    prompt: str = Field(
        default="",
        title="Prompt",
        description=(
            "The instructions the model is given. Empty, or spaces only, uses "
            "the built-in ones."
        ),
        json_schema_extra=_READ_ONLY,
    )
    max_pieces: int = Field(
        default=MAX_PIECES,
        ge=1,
        title="Most pieces",
        description=(
            "A document cut into more pieces than this is refused before any "
            "model call, since each piece is one call."
        ),
    )
    max_tokens: int = Field(
        default=MAX_TOKENS,
        ge=1,
        title="Most output tokens",
        description="The most the model may write for one piece, thinking included.",
    )


def _model_name(config: LlmContextConfig) -> str:
    if config.model == "custom":
        return config.custom_model.strip() or "(not set)"
    if config.model == "openrouter":
        return f"{config.openrouter_model.strip() or '(not set)'} on OpenRouter"
    return CHAT_MODELS[config.model].label


def _custom_complete(config: LlmContextConfig) -> bool:
    return bool(config.custom_base_url.strip() and config.custom_model.strip())


def _sum(values: list[int | None]) -> int | None:
    """A total, or None when any call did not report its count."""
    return None if any(v is None for v in values) else sum(values)


@register
class LlmContext(Transform[LlmContextConfig]):
    """`chunk_set -> chunk_set`, with a model-written context in each `embed_text`."""

    name = "llm_context"
    stage = Stage.ENRICH
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET)}
    output = ArtifactType.CHUNK_SET
    config_model = LlmContextConfig

    #: The paid output is stored: keeping it is the point. A rerun with the
    #: same pieces and settings reads it back instead of calling the model.
    cacheable = True
    deterministic = False
    summary = (
        "Asks a chat model to write one short sentence that places each piece "
        "in its document, and puts it in front of the piece before it is "
        "searched. The piece that is shown and cited does not change. It needs "
        "an API key and makes one model call per piece."
    )

    def fingerprint(self, config: LlmContextConfig | None = None) -> str:
        return (config or LlmContextConfig()).model

    def explain(self, config: LlmContextConfig) -> Explanation:
        settings = (
            f"For each piece, {_model_name(config)} (model) reads the document, "
            f"up to its first {DOC_BUDGET:,} characters, and writes one short "
            "sentence that says where the piece belongs. It goes in front of the "
            "piece when it is searched, by meaning and by keyword. A document "
            f"with more than {config.max_pieces:,} pieces (max_pieces) is refused "
            "before any call."
        )
        if config.prompt.strip():
            settings += " It gives the model your own prompt, not the built-in one."
        if config.max_tokens != MAX_TOKENS:
            settings += f" The model may write up to {config.max_tokens} tokens a piece."
        tradeoff = (
            "A piece that does not name its subject can still be found, but it "
            "costs one model call per piece, with the document sent each time as "
            "a cached prefix. The contexts are stored, so a rerun is free, but "
            "changing how the document is cut pays again in full."
        )
        warning, blocking = None, False
        if config.model == "custom" and not _custom_complete(config):
            warning, blocking = (
                "A custom endpoint needs both a base URL (for example "
                "http://localhost:11434/v1 for Ollama) and a model name.",
                True,
            )
        elif config.model == "openrouter" and not config.openrouter_model.strip():
            warning, blocking = llm.OPENROUTER_NEEDS_MODEL, True
        return Explanation(settings=settings, tradeoff=tradeoff, warning=warning, blocking=blocking)

    def apply(
        self, inputs: Mapping[str, Any], config: LlmContextConfig, ctx: RunContext
    ) -> ChunkSet:
        # A copy: the chunker's result is never changed in place.
        chunk_set = ChunkSet.model_validate(inputs["chunks"]).model_copy(deep=True)
        chunks = chunk_set.chunks
        if len(chunks) > config.max_pieces:
            raise ValueError(
                f"This document has {len(chunks)} pieces, and llm_context writes "
                f"context for at most {config.max_pieces} (max_pieces). Use bigger "
                "pieces, or raise max_pieces."
            )
        if not chunks:
            return chunk_set

        model = CHAT_MODELS[config.model]
        custom = model.provider == "openai_compatible"
        api_key = llm.key_for(model, ctx.extras.get("credentials"))
        public_only = bool(ctx.extras.get(PUBLIC_ONLY_EXTRA, False))
        if custom and not _custom_complete(config):
            raise ValueError(
                "A custom endpoint needs both a base URL and a model name. Set "
                "custom_base_url and custom_model on the enrich step."
            )
        if not custom and not api_key:
            raise ValueError(llm.no_key_message(model.provider, public_only=public_only))

        model_name = llm.model_name_for(model, config.custom_model, config.openrouter_model)
        document = chunk_set.source_text[:DOC_BUDGET]
        prefix = f"<document>\n{document}\n</document>"
        system = config.prompt.strip() or SYSTEM_PROMPT

        def call(index: int) -> llm.Completion | Exception:
            try:
                return llm.complete(
                    model,
                    system=system,
                    user=(
                        "Here is the piece to place in the document:\n"
                        f"<piece>\n{chunks[index].text}\n</piece>"
                    ),
                    cache_prefix=prefix,
                    api_key=api_key,
                    base_url=config.custom_base_url.strip() if custom else None,
                    model_name=model_name,
                    max_tokens=config.max_tokens,
                    public_only=public_only,
                )
            except Exception as exc:  # reported below, with the piece's number
                return exc

        # The first call alone writes the prompt cache; the rest then read it.
        results = [call(0)]
        if len(chunks) > 1 and not isinstance(results[0], Exception):
            with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
                results += list(pool.map(call, range(1, len(chunks))))

        done = [r for r in results if isinstance(r, llm.Completion)]
        if done:
            served = next((r.model for r in done if r.model), None)
            set_usage(
                ctx,
                {
                    key: _sum([r.usage.get(key) for r in done])
                    for key in ("input_tokens", "output_tokens", "cache_read_input_tokens")
                },
                served or model_name or model.id,
                requested_model=model_name or model.id,
            )
        for number, result in enumerate(results, start=1):
            reply, why = "", "the model gave no context"
            if isinstance(result, Exception):
                why = result
            elif result.stop_reason in _CUT_OFF:
                why = "the reply was cut off at max_tokens"
            elif result.stop_reason != "refusal":
                reply = result.text.strip()
            if not reply:
                raise RuntimeError(
                    f"The model call for piece {number} of {len(chunks)} failed: {why}. "
                    "No context was kept; run the step again."
                )

        for chunk, result in zip(chunks, results):
            chunk.embed_text = f"{result.text.strip()}\n\n{chunk.text_to_embed}"
        note = f"Wrote a context for each of the {len(chunks)} pieces, one model call each."
        if len(chunk_set.source_text) > DOC_BUDGET:
            note += (
                f" The document is longer than {DOC_BUDGET:,} characters, so the "
                f"model read only its first {DOC_BUDGET:,} characters."
            )
        set_note(ctx, note)
        return chunk_set
