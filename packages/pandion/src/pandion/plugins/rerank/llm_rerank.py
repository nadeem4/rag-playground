"""An LLM reranker: the chat model puts the candidates in order.

The prompt holds the question and the candidates numbered 1..n, each cut to
600 characters, and asks for the numbers in order of relevance, most relevant
first, and nothing else. The reply is read leniently: every number in range
counts once, in the order it first appears, and any candidate the reply skips
follows in its prior order. So a reply with repeats, gaps or words around the
numbers still gives a full order with no duplicates.

It follows the `mmr` contract: `retrieval_result -> retrieval_result`, an
ambient `query`, and every returned hit carries `prior_rank` and `prior_score`.
The model gives no score, so `score` stays the retriever's.

The key comes from `ctx.extras["credentials"]` exactly as the chat step reads
it, and `pandion.llm.complete` keeps it out of every error message. A model
call is not a function of its inputs, so the step is never cached.

A server that strangers share passes `ctx.extras["public_endpoints_only"]`,
as for `llm_rewrite`: a custom endpoint must then be a public https address
(`pandion.endpoints`), and no message suggests setting a key on the server.
The explanation has no run to read that from, so it never names the server
variable; the run's error does, when the server is not shared.
"""

from __future__ import annotations

import re
import time
from typing import Any, ClassVar, Literal, Mapping

from pydantic import Field

from pandion.artifacts import ArtifactType
from pandion.ids import AddedSettings
from pandion.payloads import Hit, Query, RetrievalResult
from pandion.ports import PortSpec, RunContext, Stage, set_note, set_usage
from pandion.registry import register
from pandion.transform import Explanation, Transform
from pandion import llm
from pandion.endpoints import PUBLIC_ONLY_EXTRA
from pandion.llm import CHAT_MODELS

#: How much of each candidate the model reads.
TEXT_BUDGET = 600

#: Room for a reasoning model's thinking plus a short list of numbers.
MAX_TOKENS = 16000

SYSTEM_PROMPT = (
    "You rank passages by how well they answer a question. Answer with the "
    "passage numbers in order of relevance, most relevant first, separated by "
    "commas, and nothing else."
)

_SHOW_IF_CUSTOM = {"x-show-when": {"model": "custom"}}
_SHOW_IF_OPENROUTER = {"x-show-when": {"model": "openrouter"}}

#: A prompt is shown read-only in the playground's forms (owner, 2026-10-13).
_READ_ONLY = {"readOnly": True}


def _key_words(provider: str) -> str:
    """How this step says it needs a key. It never names the server variable:
    an explanation cannot tell whether strangers share the server."""
    if provider == "openai_compatible":
        return (
            "A key is optional, added with the key button at the top right, and a "
            "local server usually needs none. Custom endpoints are turned off in "
            "the hosted demo."
        )
    return llm.key_sentence(provider, public_only=True)


class LlmRerankConfig(AddedSettings):
    added: ClassVar[tuple[str, ...]] = ("prompt", "text_budget_chars", "max_tokens")

    model: Literal[tuple(CHAT_MODELS)] = Field(  # type: ignore[valid-type]
        title="Model",
        description=(
            "The chat model that scores each piece against the question. It "
            "needs a key."
        ),
        default="claude-haiku-4-5",
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
    #: How many it keeps from the retriever's candidate pool (20 by default).
    top_k: int = Field(
        default=5,
        title="Pieces kept",
        description="How many pieces the reranker keeps.",
    )
    #: Added after version 3's results were stored; see pandion.ids.AddedSettings.
    prompt: str = Field(
        default=SYSTEM_PROMPT,
        min_length=1,
        title="Prompt",
        description="The instructions the model is given.",
        json_schema_extra=_READ_ONLY,
    )
    text_budget_chars: int = Field(
        default=TEXT_BUDGET,
        ge=1,
        title="Characters read per piece",
        description="How much of each candidate piece the model reads, in characters.",
    )
    max_tokens: int = Field(
        default=MAX_TOKENS,
        ge=1,
        title="Most output tokens",
        description="The most the model may write, thinking included.",
    )


def _custom_complete(config: LlmRerankConfig) -> bool:
    return bool(config.custom_base_url.strip() and config.custom_model.strip())


def _model_name(config: LlmRerankConfig) -> str:
    if config.model == "custom":
        return config.custom_model.strip() or "(not set)"
    if config.model == "openrouter":
        return f"{config.openrouter_model.strip() or '(not set)'} on OpenRouter"
    return CHAT_MODELS[config.model].label


@register
class LlmRerank(Transform[LlmRerankConfig]):
    """`retrieval_result -> retrieval_result`, so it stacks with other rerankers."""

    name = "llm_rerank"
    version = "3"
    stage = Stage.RERANK
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    config_model = LlmRerankConfig

    #: A model's answer, not a function of its inputs.
    cacheable = False
    deterministic = False
    summary = (
        "Asks a chat model to read the question and every candidate piece and "
        "put the pieces in order of relevance. It needs an API key and makes "
        "one model call per question."
    )

    def fingerprint(self, config: LlmRerankConfig | None = None) -> str:
        return (config or LlmRerankConfig()).model

    def explain(self, config: LlmRerankConfig) -> Explanation:
        model = CHAT_MODELS[config.model]
        settings = (
            f"It asks {_model_name(config)} to put the candidates from the "
            "retriever (20 by default) in order of relevance, reading the first "
            f"{config.text_budget_chars} characters of each, and keeps the {config.top_k} "
            f"best. It judges each piece against the question as you typed it, "
            "even when the question was rewritten for retrieval. "
            f"{_key_words(model.provider)}"
        )
        if config.prompt != SYSTEM_PROMPT:
            settings += " It gives the model your own prompt, not the built-in one."
        if config.max_tokens != MAX_TOKENS:
            settings += f" The model may write up to {config.max_tokens} tokens."
        tradeoff = (
            "A model can judge relevance well, but it costs one model call per "
            "question and takes seconds. Its order can change between runs, "
            "because the model's answer can. The model gives no score, so each "
            "piece keeps the score it had from the retriever. Read the rank, not "
            "the score."
        )
        warning, blocking = None, False
        if config.top_k < 1:
            warning, blocking = "top_k must be at least 1.", True
        elif model.provider == "openai_compatible" and not _custom_complete(config):
            warning, blocking = (
                "A custom endpoint needs both a base URL (for example "
                "http://localhost:11434/v1 for Ollama) and a model name.",
                True,
            )
        elif model.provider == "openrouter" and not config.openrouter_model.strip():
            warning, blocking = llm.OPENROUTER_NEEDS_MODEL, True
        return Explanation(
            settings=settings, tradeoff=tradeoff, warning=warning, blocking=blocking
        )

    def apply(
        self, inputs: Mapping[str, Any], config: LlmRerankConfig, ctx: RunContext
    ) -> dict[str, Any]:
        result = RetrievalResult.model_validate(inputs["result"])
        question = Query.model_validate(inputs["query"]).asked
        hits = result.hits
        if not hits:
            return result.model_dump(mode="json")

        model = CHAT_MODELS[config.model]
        custom = model.provider == "openai_compatible"
        api_key = llm.key_for(model, ctx.extras.get("credentials"))
        public_only = bool(ctx.extras.get(PUBLIC_ONLY_EXTRA, False))
        if custom and not _custom_complete(config):
            raise ValueError(
                "A custom endpoint needs both a base URL and a model name. Set "
                "custom_base_url and custom_model on the rerank node."
            )
        if not custom and not api_key:
            raise ValueError(
                llm.no_key_message(model.provider, public_only=public_only)
            )

        prior_ids = [hit.chunk.id for hit in hits]
        for hit in hits:
            hit.prior_rank = hit.rank
            hit.prior_score = hit.score

        model_name = llm.model_name_for(model, config.custom_model, config.openrouter_model)
        started = time.perf_counter()
        completion = llm.complete(
            model,
            system=config.prompt,
            user=_prompt(question, hits, config.text_budget_chars),
            api_key=api_key,
            base_url=config.custom_base_url.strip() if custom else None,
            model_name=model_name,
            max_tokens=config.max_tokens,
            public_only=public_only,
        )
        elapsed = time.perf_counter() - started
        set_usage(
            ctx,
            completion.usage,
            completion.model or model_name or model.id,
        )

        reply = "" if completion.stop_reason == "refusal" else completion.text
        usable = _numbers(reply, len(hits))
        order = parse_order(reply, len(hits))[: config.top_k]
        result.hits = [_at_rank(hits[index], rank) for rank, index in enumerate(order, 1)]
        result.total_candidates = len(hits)

        moved = sum(
            1 for hit, prior in zip(result.hits, prior_ids) if hit.chunk.id != prior
        )
        if usable:
            note = (
                f"{_model_name(config)} ordered {len(hits)} candidates in "
                f"{elapsed:.1f} s. {moved} of the top {len(result.hits)} changed place."
            )
        else:
            note = (
                f"{_model_name(config)} gave no usable order, so the retriever's "
                "order was kept."
            )
        set_note(ctx, note)
        return result.model_dump(mode="json")


def _prompt(question: str, hits: list[Hit], budget: int = TEXT_BUDGET) -> str:
    candidates = "\n\n".join(
        f"[{n}] {hit.chunk.text[:budget]}" for n, hit in enumerate(hits, 1)
    )
    return (
        f"Question: {question}\n\nPassages:\n\n{candidates}\n\n"
        f"Answer with the numbers 1 to {len(hits)} in order of relevance, most "
        "relevant first, and nothing else."
    )


def parse_order(reply: str, n: int) -> list[int]:
    """Indices 0..n-1: the reply's numbers first, then the rest in prior order."""
    seen = _numbers(reply, n)
    return seen + [i for i in range(n) if i not in seen]


def _numbers(reply: str, n: int) -> list[int]:
    """The reply's in-range numbers as indices, first appearance only."""
    seen: list[int] = []
    for token in re.findall(r"\d+", reply):
        index = int(token) - 1
        if 0 <= index < n and index not in seen:
            seen.append(index)
    return seen


def _at_rank(hit: Hit, rank: int) -> Hit:
    hit.rank = rank
    return hit
