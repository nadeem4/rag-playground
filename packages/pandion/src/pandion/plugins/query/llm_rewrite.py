"""An LLM rewrite of the question, for retrieval only.

A question in the reader's own words can share no word with the document: "Who
is my current employer?" against a resume that says "Present" matches nothing
in keyword search, and vector search ranks the right piece fifth. A chat model
restates the question in the words the document would use, and retrieval
searches with that. The question as typed is kept in `Query.original`, and the
answer step reads it from there, so the person is answered in their own words.

The parsed document is an optional ambient input: when there is one, the model
reads its first 1,500 characters to learn its vocabulary. The key comes from
`ctx.extras["credentials"]` as for the chat step and the LLM reranker, and a
model call is not a function of its inputs, so the step is never cached.

A server that strangers share passes `ctx.extras["public_endpoints_only"]`,
and a custom endpoint must then be a public https address (`pandion.endpoints`).

The SDK it needs is an extra: `pandion[anthropic]` for Claude models, and
`pandion[openai]` for OpenAI, OpenRouter and a custom endpoint.
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal, Mapping

from pydantic import Field

from pandion.artifacts import ArtifactType
from pandion.ids import AddedSettings
from pandion.payloads import ParsedDoc, Query
from pandion.ports import PortSpec, RunContext, Stage, set_note, set_usage
from pandion.registry import register
from pandion.transform import Explanation, Transform
from pandion import llm
from pandion.endpoints import PUBLIC_ONLY_EXTRA
from pandion.llm import CHAT_MODELS
from pandion.plugins.query.text import TextQueryConfig

#: How much of the document the model reads for its vocabulary.
DOC_BUDGET = 1500

#: A rewrite longer than this is an answer or an essay, not a question.
MAX_REWRITE = 300

#: Room for a reasoning model's thinking plus one short line.
MAX_TOKENS = 16000

UNUSABLE_NOTE = "The model gave no usable rewrite; the question was used as typed."

_ASK = {
    "document words": (
        "Restate the question in the words the document would use, so a "
        "keyword search finds the passage that answers it."
    ),
    "keywords": (
        "Turn the question into six to ten search words that the passage "
        "answering it would contain, separated by spaces."
    ),
}

_SHOW_IF_CUSTOM = {"x-show-when": {"model": "custom"}}
_SHOW_IF_OPENROUTER = {"x-show-when": {"model": "openrouter"}}

#: A prompt is shown read-only in the playground's forms (owner, 2026-10-13).
_READ_ONLY = {"readOnly": True}


def system_prompt(style: str) -> str:
    return (
        f"You rewrite a question for a search over one document. {_ASK[style]} "
        "Prefer the document's section and date words (such as Experience, "
        "Present, years) over general words. Never use a person's name. "
        "Reply with one line only. Do not answer the question."
    )


class LlmRewriteConfig(TextQueryConfig, AddedSettings):
    added: ClassVar[tuple[str, ...]] = (
        "prompt", "doc_budget_chars", "max_rewrite_chars", "max_tokens"
    )

    text: str = Field(
        title="Question",
        default="",
        description=(
            "The question as typed. The model rewrites it for retrieval; the "
            "answer step still uses it as typed."
        ),
    )
    model: Literal[tuple(CHAT_MODELS)] = Field(  # type: ignore[valid-type]
        title="Model",
        default="claude-haiku-4-5",
        description=(
            "The chat model that rewrites the question: the same choices as the"
            " chat step."
        ),
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
    style: Literal["document words", "keywords"] = Field(
        title="Style",
        default="document words",
        description=(
            "'document words' restates the question in the document's words; "
            "'keywords' turns it into six to ten search words."
        ),
    )
    #: Added after version 2's results were stored; see pandion.ids.AddedSettings.
    prompt: str = Field(
        default="",
        title="Prompt",
        description=(
            "The instructions the model is given. Empty, or spaces only, uses "
            "the built-in ones for the style."
        ),
        json_schema_extra=_READ_ONLY,
    )
    doc_budget_chars: int = Field(
        default=DOC_BUDGET,
        ge=0,
        title="Document characters read",
        description="How much of the start of the document the model reads, in characters.",
    )
    max_rewrite_chars: int = Field(
        default=MAX_REWRITE,
        ge=1,
        title="Longest rewrite",
        description=(
            "A rewrite longer than this, in characters, is not used; the question "
            "is searched as asked."
        ),
    )
    max_tokens: int = Field(
        default=MAX_TOKENS,
        ge=1,
        title="Most output tokens",
        description="The most the model may write, thinking included.",
    )


def _custom_complete(config: LlmRewriteConfig) -> bool:
    return bool(config.custom_base_url.strip() and config.custom_model.strip())


def _model_name(config: LlmRewriteConfig) -> str:
    if config.model == "custom":
        return config.custom_model.strip() or "(not set)"
    if config.model == "openrouter":
        return f"{config.openrouter_model.strip() or '(not set)'} on OpenRouter"
    return CHAT_MODELS[config.model].label


@register
class LlmRewrite(Transform[LlmRewriteConfig]):
    """`(parsed_doc?) -> query`. Bound ambiently, like the `text` query."""

    name = "llm_rewrite"
    version = "2"
    stage = Stage.QUERY
    inputs = {
        "doc": PortSpec(ArtifactType.PARSED_DOC, ambient=True, required=False),
    }
    output = ArtifactType.QUERY
    config_model = LlmRewriteConfig

    #: A model's answer, not a function of its inputs.
    cacheable = False
    deterministic = False
    summary = (
        "Asks a chat model to restate your question in the words the document "
        "would use, and searches with that. The answer still uses your question "
        "as typed. It needs an API key and makes one model call per question."
    )

    def fingerprint(self, config: LlmRewriteConfig | None = None) -> str:
        return (config or LlmRewriteConfig()).model

    def explain(self, config: LlmRewriteConfig) -> Explanation:
        how = (
            "restate it in the words the document would use"
            if config.style == "document words"
            else "turn it into six to ten search words"
        )
        settings = (
            f"It asks {_model_name(config)} (model) to {how} (style is "
            f"{config.style}), reading the first {config.doc_budget_chars} characters of the "
            "parsed document when there is one. Retrieval searches with the "
            "rewrite; the original question still goes to the answer."
        )
        if config.prompt.strip():
            settings += " It gives the model your own prompt, not the built-in one."
        if config.max_rewrite_chars != MAX_REWRITE:
            settings += (
                f" A rewrite longer than {config.max_rewrite_chars} characters is "
                "not used."
            )
        if config.max_tokens != MAX_TOKENS:
            settings += f" The model may write up to {config.max_tokens} tokens."
        tradeoff = (
            "A rewrite in the document's words lets keyword search match a "
            "question that shares no word with it, but it costs one model call "
            "and a second or two, and it can change between runs. If the model "
            "misreads the question, retrieval searches for the wrong thing."
        )
        warning, blocking = None, False
        if not config.text.strip():
            warning = "The question is empty, so there is nothing to rewrite."
        elif config.model == "custom" and not _custom_complete(config):
            warning, blocking = (
                "A custom endpoint needs both a base URL (for example "
                "http://localhost:11434/v1 for Ollama) and a model name.",
                True,
            )
        elif config.model == "openrouter" and not config.openrouter_model.strip():
            warning, blocking = llm.OPENROUTER_NEEDS_MODEL, True
        return Explanation(
            settings=settings, tradeoff=tradeoff, warning=warning, blocking=blocking
        )

    def apply(
        self, inputs: Mapping[str, Any], config: LlmRewriteConfig, ctx: RunContext
    ) -> dict[str, Any]:
        query = Query(
            text=config.text,
            gold_answer=config.gold_answer,
            gold_answers=config.gold_answers,
        )
        question = config.text.strip()
        if not question:
            return query.model_dump(mode="json")

        model = CHAT_MODELS[config.model]
        custom = model.provider == "openai_compatible"
        api_key = llm.key_for(model, ctx.extras.get("credentials"))
        public_only = bool(ctx.extras.get(PUBLIC_ONLY_EXTRA, False))
        if custom and not _custom_complete(config):
            raise ValueError(
                "A custom endpoint needs both a base URL and a model name. Set "
                "custom_base_url and custom_model on the query node."
            )
        if not custom and not api_key:
            raise ValueError(llm.no_key_message(model.provider, public_only=public_only))

        model_name = llm.model_name_for(model, config.custom_model, config.openrouter_model)
        completion = llm.complete(
            model,
            system=config.prompt.strip() or system_prompt(config.style),
            user=_prompt(question, inputs.get("doc"), config.doc_budget_chars),
            api_key=api_key,
            base_url=config.custom_base_url.strip() if custom else None,
            model_name=model_name,
            max_tokens=config.max_tokens,
            public_only=public_only,
        )
        set_usage(
            ctx,
            completion.usage,
            completion.model or model_name or model.id,
            requested_model=model_name or model.id,
        )
        reply = "" if completion.stop_reason == "refusal" else completion.text.strip()
        if not reply or len(reply) > config.max_rewrite_chars or "\n" in reply:
            set_note(ctx, UNUSABLE_NOTE)
            return query.model_dump(mode="json")

        query.original = config.text
        query.text = reply
        stop = "" if reply.endswith((".", "?", "!")) else "."
        set_note(ctx, f"Rewrote the question as: {reply}{stop}")
        return query.model_dump(mode="json")


def _prompt(question: str, doc: Any, budget: int = DOC_BUDGET) -> str:
    if doc is None:
        return f"Question: {question}"
    start = ParsedDoc.model_validate(doc).render_markdown()[0][:budget]
    return f"The document begins:\n\n{start}\n\nQuestion: {question}"
