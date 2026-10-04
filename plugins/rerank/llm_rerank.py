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
it, and `providers.llm.complete` keeps it out of every error message. A model
call is not a function of its inputs, so the step is never cached.
"""

from __future__ import annotations

import re
import time
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import Hit, Query, RetrievalResult
from core.ports import PortSpec, RunContext, Stage, set_note
from core.registry import register
from core.transform import Explanation, Transform
from providers import llm
from providers.llm import CHAT_MODELS

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

_KEY_WORDS: dict[str, str] = {
    "anthropic": (
        "It needs an Anthropic API key, added with the key button at the top "
        "right or set as ANTHROPIC_API_KEY on the server."
    ),
    "openai": (
        "It needs an OpenAI API key, added with the key button at the top "
        "right or set as OPENAI_API_KEY on the server."
    ),
    "openai_compatible": (
        "A key is optional, added with the key button at the top right, and a "
        "local server usually needs none. Custom endpoints are turned off in "
        "the hosted demo."
    ),
}


class LlmRerankConfig(BaseModel):
    model: Literal[tuple(CHAT_MODELS)] = Field(  # type: ignore[valid-type]
        default="claude-haiku-4-5",
        json_schema_extra={"x-labels": {m.id: m.label for m in CHAT_MODELS.values()}},
    )
    custom_base_url: str = Field(default="", json_schema_extra=_SHOW_IF_CUSTOM)
    custom_model: str = Field(default="", json_schema_extra=_SHOW_IF_CUSTOM)
    #: How many it keeps from the retriever's candidate pool (20 by default).
    top_k: int = 5


def _custom_complete(config: LlmRerankConfig) -> bool:
    return bool(config.custom_base_url.strip() and config.custom_model.strip())


def _model_name(config: LlmRerankConfig) -> str:
    if config.model == "custom":
        return config.custom_model.strip() or "(not set)"
    return CHAT_MODELS[config.model].label


@register
class LlmRerank(Transform[LlmRerankConfig]):
    """`retrieval_result -> retrieval_result`, so it stacks with other rerankers."""

    name = "llm_rerank"
    version = "2"
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
            f"{TEXT_BUDGET} characters of each, and keeps the {config.top_k} "
            f"best. It judges each piece against the question as you typed it, "
            "even when the question was rewritten for retrieval. "
            f"{_KEY_WORDS[model.provider]}"
        )
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
        if custom and not _custom_complete(config):
            raise ValueError(
                "A custom endpoint needs both a base URL and a model name. Set "
                "custom_base_url and custom_model on the rerank node."
            )
        if not custom and not api_key:
            raise ValueError(llm.NO_KEY[model.provider])

        prior_ids = [hit.chunk.id for hit in hits]
        for hit in hits:
            hit.prior_rank = hit.rank
            hit.prior_score = hit.score

        started = time.perf_counter()
        completion = llm.complete(
            model,
            system=SYSTEM_PROMPT,
            user=_prompt(question, hits),
            api_key=api_key,
            base_url=config.custom_base_url.strip() if custom else None,
            model_name=config.custom_model.strip() if custom else None,
            max_tokens=MAX_TOKENS,
        )
        elapsed = time.perf_counter() - started

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


def _prompt(question: str, hits: list[Hit]) -> str:
    candidates = "\n\n".join(
        f"[{n}] {hit.chunk.text[:TEXT_BUDGET]}" for n, hit in enumerate(hits, 1)
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
