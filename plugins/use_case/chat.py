"""Chat: an answer from a chat model in which every claim points at its source.

Two ways to cite, chosen by `citation_method` (I-17):

- **native** (Claude only, and what `auto` picks for a Claude model). Each
  retrieved chunk goes to the Messages API as a plain-text `document` block with
  citations enabled. Claude answers in `text` blocks, and the cited ones carry
  `char_location` citations: character offsets *into that chunk*.
- **sentence ids** (any model: Claude, OpenAI, any OpenAI-compatible server;
  what `auto` picks for a model without a citations API). Every chunk is cut
  into numbered sentences, the model puts the ids it relied on after each
  claim, and each claim is checked against its sentences with the index's own
  embedder (`_grounding`). The model points, and we quote.

Either way, adding the chunk's `start_char` turns an offset into the chunk into
an offset into the parsed document's rendered markdown, which is what the
chunker cut from. From there the element whose span contains the start gives
the page and the bbox the PDF viewer highlights.

Three rules carry the design:

- **The original text, never `embed_text`.** A citation that quotes an
  augmentation (contextual retrieval, propositions) is a fabricated quote.
- **Verify, never drop.** `doc_md[doc_start:doc_end] == cited_text` is checked
  for every citation. A failure is kept with `verified: false`, because the UI
  must show that the grounding is broken rather than silently lose it.
- **The key is a secret.** Each provider's key arrives in
  `ctx.extras["credentials"]` (I-8, I-18), is handed to the client factory and
  to nothing else, and any SDK error is re-raised as a fresh message with the
  key scrubbed and the original chain dropped, so it cannot surface in a
  traceback.

The SDKs are imported lazily (`providers.llm`), so registering the plugin
(every API start, every test run) costs nothing.

**Native API call shape**, per the claude-api skill: non-streaming
`client.beta.messages.create` with `max_tokens=16000` (the skill's non-streaming
default; a grounded answer is short, and the node returns one payload so there
is nothing to stream to). Adaptive thinking on the models that support it. On
`claude-opus-5`, server-side fallbacks in their `"default"` mode, which reroute
a safety-classifier refusal by category; the skill documents them only for
Opus 5 and Fable 5.1, so Sonnet 5 and Haiku 4.5 are sent without. No
`output_config.format`: citations and structured outputs are a 400 together.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import Hit, Output, ParsedDoc, Query, RetrievalResult
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Explanation, Transform
from plugins.use_case._grounding import (
    GroundedClaim,
    Sentence,
    ground,
    number_sources,
    parse_answer,
)
from providers import llm
from providers.llm import CHAT_MODELS, ChatModel

NO_KEY_MESSAGE = llm.NO_KEY["anthropic"]

SYSTEM_PROMPT = (
    "Answer the user's question using only the provided documents. "
    "If the documents do not contain the answer, say so plainly instead of "
    "guessing or drawing on outside knowledge. Be concise."
)

#: The sentence-id system prompt, identical for every provider (I-19).
SENTENCE_PROMPT = (
    "Answer using only the sources below. After each claim, put the ids of the "
    "sentences that support it in brackets, like [2.2] or [2.2][4.1]. If the "
    "sources do not support a claim, do not make it."
)

#: Enough room for adaptive thinking (or an OpenAI model's reasoning) plus a
#: short answer, and within the skill's ceiling for a non-streaming request.
MAX_TOKENS = 16000

#: The claim labels `stats` counts, in order.
LABELS = ("cited", "weak", "similarity", "none")

_SHOW_IF_CUSTOM = {"x-show-when": {"model": "custom"}}


class ChatConfig(BaseModel):
    model: Literal[tuple(CHAT_MODELS)] = Field(  # type: ignore[valid-type]
        default="claude-opus-5",
        json_schema_extra={"x-labels": {m.id: m.label for m in CHAT_MODELS.values()}},
    )
    custom_base_url: str = Field(default="", json_schema_extra=_SHOW_IF_CUSTOM)
    custom_model: str = Field(default="", json_schema_extra=_SHOW_IF_CUSTOM)
    #: `auto`: native citations when the model has them, else sentence ids.
    citation_method: Literal["auto", "sentence_ids"] = "auto"
    support_threshold: float = Field(default=0.55, ge=0, le=1)
    max_chunks: int = Field(default=5, ge=1)


#: How each Claude model is described to a newcomer: its cost, in words.
_CLAUDE_COST: dict[str, str] = {
    "claude-opus-5": (
        "the most capable of the three Claude models and the most expensive per question"
    ),
    "claude-sonnet-5": "a balance of quality and price, cheaper per question than Opus 5",
    "claude-haiku-4-5": (
        "the fastest and cheapest of the three Claude models, and the weakest on "
        "hard questions"
    ),
}

_KEY_WORDS: dict[str, str] = {
    "anthropic": (
        "It needs an Anthropic API key (API key, top right, or ANTHROPIC_API_KEY "
        "in .env), and every run is a new paid request, never a cached answer."
    ),
    "openai": (
        "It needs an OpenAI API key (API key, top right, or OPENAI_API_KEY in "
        ".env), and every run is a new paid request, never a cached answer."
    ),
    "openai_compatible": (
        "A key is optional (API key, top right, or OPENAI_COMPATIBLE_API_KEY in "
        ".env); a local server usually needs none. Every run is a new request, "
        "never a cached answer. Custom endpoints are turned off in the hosted demo."
    ),
}

_CREDENTIAL: dict[str, str] = {
    "anthropic": "anthropic_api_key",
    "openai": "openai_api_key",
    "openai_compatible": "custom_api_key",
}


def make_client(api_key: str) -> Any:
    """The client for the native path. Tests monkeypatch this."""
    return llm.make_anthropic_client(api_key)


def uses_native(config: ChatConfig) -> bool:
    """Whether the native citations path is the one that actually runs."""
    return config.citation_method == "auto" and CHAT_MODELS[config.model].native_citations


def _custom_complete(config: ChatConfig) -> bool:
    return bool(config.custom_base_url.strip() and config.custom_model.strip())


@register
class ChatUseCase(Transform[ChatConfig]):
    """`retrieval_result (+ query, parsed_doc, index) -> output`."""

    name = "chat"
    version = "2"
    stage = Stage.USE_CASE
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
        "doc": PortSpec(ArtifactType.PARSED_DOC, ambient=True),
        # Ambient: the index says which embedder, at which width, the support
        # check compares claims and sentences in. The same rule as MMR.
        "index": PortSpec(ArtifactType.INDEX, ambient=True),
    }
    output = ArtifactType.OUTPUT
    config_model = ChatConfig

    #: A generation, not a function of its inputs: replaying a cached answer
    #: would make asking twice look deterministic when it is not.
    cacheable = False
    deterministic = False
    summary = (
        "Sends the retrieved pieces and your question to a chat model (Claude, "
        "OpenAI, or any OpenAI-compatible server), which answers using only "
        "those pieces. Every claim points at the passages it relied on, and each "
        "citation is checked against the parsed document."
    )

    def explain(self, config: ChatConfig) -> Explanation:
        model = CHAT_MODELS[config.model]
        n, t = config.max_chunks, config.support_threshold
        pieces = f"up to {n} retrieved piece{'s' if n != 1 else ''}"
        if model.provider == "anthropic":
            who = f"Answers with {model.label}, {_CLAUDE_COST[model.id]}."
        elif model.provider == "openai":
            who = f"Answers with OpenAI's {model.label}."
        else:
            who = (
                f"Answers with the model {config.custom_model.strip() or '(not set)'} "
                f"on the custom endpoint {config.custom_base_url.strip() or '(not set)'}."
            )

        if uses_native(config):
            method = (
                "Citations come from Claude's own citations feature, which quotes "
                "the exact passages; every citation is verified against the "
                "parsed text, and one that does not match is shown as unverified "
                f"rather than hidden. The support threshold ({t:g}) is used only "
                "with sentence ids."
            )
            tradeoff = (
                "More pieces give the model more evidence, but make each request "
                "longer and pricier, and weak pieces can distract it. It can only "
                "read as many pieces as the step before passes on."
            )
        else:
            why = (
                "chosen instead of Claude's own citations"
                if model.native_citations
                else "because this model has no citations feature of its own"
            )
            method = (
                f"Citations use sentence ids, {why}: every sentence of the pieces "
                "gets an id, the model writes the ids it relied on after each "
                "claim, and the playground quotes those sentences itself. Each "
                "claim is then compared with its sentences using the index's "
                f"embedder: at a similarity of {t:g} or more it is cited, below "
                "that it is marked weak. A claim with no ids gets the closest "
                f"sentence shown if that reaches {t:g}, and is marked not "
                "grounded otherwise."
            )
            tradeoff = (
                "A higher threshold asks for closer wording before a claim counts "
                "as cited, so more claims show as weak; a lower one accepts "
                "looser matches. The check measures how alike the words are, not "
                "whether the claim is true. More pieces give more evidence but a "
                "longer, pricier request."
            )

        warning, blocking = None, False
        if model.provider == "openai_compatible" and not _custom_complete(config):
            warning, blocking = (
                "A custom endpoint needs both a base URL (for example "
                "http://localhost:11434/v1 for Ollama) and a model name.",
                True,
            )
        return Explanation(
            settings=f"{who} It reads {pieces}. {method} {_KEY_WORDS[model.provider]}",
            tradeoff=tradeoff,
            warning=warning,
            blocking=blocking,
        )

    def fingerprint(self, config: ChatConfig | None = None) -> str:
        return (config or ChatConfig()).model

    def apply(
        self, inputs: Mapping[str, Any], config: ChatConfig, ctx: RunContext
    ) -> dict[str, Any]:
        creds = ctx.extras.get("credentials") or {}
        if uses_native(config):
            return _native(inputs, config, creds.get("anthropic_api_key"))
        model = CHAT_MODELS[config.model]
        return _sentence_ids(inputs, config, model, creds.get(_CREDENTIAL[model.provider]))


# --------------------------------------------------------------------------
# the native path (Claude's citations API)
# --------------------------------------------------------------------------


def _native(
    inputs: Mapping[str, Any], config: ChatConfig, api_key: str | None
) -> dict[str, Any]:
    if not api_key:
        raise ValueError(NO_KEY_MESSAGE)

    hits = RetrievalResult.model_validate(inputs["result"]).hits[: config.max_chunks]
    question = Query.model_validate(inputs["query"]).text
    doc = ParsedDoc.model_validate(inputs["doc"])

    request: dict[str, Any] = {
        "model": config.model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": [_document(hit) for hit in hits]
                + [{"type": "text", "text": question}],
            }
        ],
        **llm.anthropic_request_extras(config.model),
    }

    response = llm.call_anthropic(make_client(api_key), request, api_key)

    payload: dict[str, Any] = {
        "question": question,
        "model": getattr(response, "model", None) or config.model,
        "provider": "anthropic",
        "citation_method": "native",
        "usage": {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        },
        "stop_reason": response.stop_reason,
    }
    # Check the stop reason before reading content: a refusal may come with
    # no content at all, or with a partial answer that must not be shown.
    if response.stop_reason == "refusal":
        payload["answer"] = [
            {"text": _declined(response), "citations": [], "grounding": None}
        ]
        payload["citations"] = []
        payload["stats"] = _stats()
    else:
        payload["answer"], payload["citations"] = _ground(response.content, hits, doc)
        # Native segments carry no label; stats count cited and uncited claims,
        # skipping pieces with no words (". ").
        claims = [a for a in payload["answer"] if any(ch.isalnum() for ch in a["text"])]
        payload["stats"] = _stats(
            cited=sum(1 for a in claims if a["citations"]),
            none=sum(1 for a in claims if not a["citations"]),
        )
    return Output(kind="chat", payload=payload).model_dump(mode="json")


def _document(hit: Hit) -> dict[str, Any]:
    chunk = hit.chunk
    page = f"p.{chunk.page_span[0]} " if chunk.page_span else ""
    return {
        "type": "document",
        "source": {"type": "text", "media_type": "text/plain", "data": chunk.text},
        "title": f"{page}chunk {chunk.ordinal}",
        "citations": {"enabled": True},
    }


def _declined(response: Any) -> str:
    details = getattr(response, "stop_details", None)
    category = getattr(details, "category", None) if details else None
    suffix = f" (category: {category})" if category else ""
    return f"The model declined to answer this request{suffix}."


def _ground(
    content: list[Any], hits: list[Hit], doc: ParsedDoc
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Answer segments in order, and the numbered citations they point at."""
    doc_md, spans = doc.render_markdown()
    elements = {e.id: e for e in doc.elements}
    numbers: dict[tuple[Any, ...], int] = {}
    citations: list[dict[str, Any]] = []
    answer: list[dict[str, Any]] = []

    for block in content:
        # Thinking and fallback-marker blocks are not part of the answer.
        if block.type != "text":
            continue
        refs: list[int] = []
        # Plain-text documents always produce `char_location` citations.
        for c in block.citations or []:
            if c.type != "char_location":
                continue
            chunk = hits[c.document_index].chunk if c.document_index < len(hits) else None
            key = (
                chunk.id if chunk else f"#{c.document_index}",
                c.start_char_index,
                c.end_char_index,
            )
            if key not in numbers:
                numbers[key] = len(citations) + 1
                entry = _citation(numbers[key], c, chunk, doc, doc_md, spans, elements)
                entry["method"], entry["support"] = "native", None
                citations.append(entry)
            if numbers[key] not in refs:
                refs.append(numbers[key])
        answer.append({"text": block.text, "citations": refs, "grounding": None})
    return answer, citations


# --------------------------------------------------------------------------
# the sentence-id path (any model)
# --------------------------------------------------------------------------


def _sentence_ids(
    inputs: Mapping[str, Any], config: ChatConfig, model: ChatModel, api_key: str | None
) -> dict[str, Any]:
    custom = model.provider == "openai_compatible"
    if custom and not _custom_complete(config):
        raise ValueError(
            "A custom endpoint needs both a base URL and a model name. Set "
            "custom_base_url and custom_model on the chat node."
        )
    if not custom and not api_key:
        raise ValueError(llm.NO_KEY[model.provider])
    if inputs.get("index") is None:
        raise ValueError(
            "Sentence-id citations need the index: its embedder checks each "
            "claim against the sentences it cites."
        )

    hits = RetrievalResult.model_validate(inputs["result"]).hits[: config.max_chunks]
    question = Query.model_validate(inputs["query"]).text
    doc = ParsedDoc.model_validate(inputs["doc"])
    block, table = number_sources([hit.chunk for hit in hits])

    completion = llm.complete(
        model,
        system=SENTENCE_PROMPT,
        user=f"{block}\n\nQuestion: {question}",
        api_key=api_key,
        base_url=config.custom_base_url.strip() if custom else None,
        model_name=config.custom_model.strip() if custom else None,
        max_tokens=MAX_TOKENS,
    )

    payload: dict[str, Any] = {
        "question": question,
        "model": config.custom_model.strip() if custom else model.id,
        "provider": model.provider,
        "citation_method": "sentence_ids",
        "usage": completion.usage,
        "stop_reason": completion.stop_reason,
    }
    if completion.stop_reason == "refusal":
        payload["answer"] = [{"text": completion.text, "citations": [], "grounding": None}]
        payload["citations"] = []
        payload["stats"] = _stats()
        return Output(kind="chat", payload=payload).model_dump(mode="json")

    claims, unknown = parse_answer(completion.text, table)
    grounded = ground(claims, table, _index_embed(inputs["index"]), config.support_threshold)
    payload["answer"], payload["citations"] = _sentence_citations(grounded, table, hits, doc)
    counts = {label: sum(1 for g in grounded if g.label == label) for label in LABELS}
    payload["stats"] = _stats(**counts, unknown_ids=unknown)
    return Output(kind="chat", payload=payload).model_dump(mode="json")


def _index_embed(index: Any):
    """The index's own embedder at its own width, through the embedding cache."""
    from plugins.retrieve import _base
    from providers.embedding_cache import embed_cached

    embedder, dim = _base.embedder_for(_base.read_descriptor(index))

    def embed(texts: list[str]) -> list[list[float]]:
        return embed_cached(embedder, list(texts), kind="document", dim=dim)[0]

    return embed


def _sentence_citations(
    grounded: list[GroundedClaim],
    table: dict[str, Sentence],
    hits: list[Hit],
    doc: ParsedDoc,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Answer segments and numbered citations, in the native path's shape."""
    doc_md, spans = doc.render_markdown()
    elements = {e.id: e for e in doc.elements}
    numbers: dict[str, int] = {}
    citations: list[dict[str, Any]] = []
    answer: list[dict[str, Any]] = []
    for g in grounded:
        refs: list[int] = []
        for sid, support in g.citations:
            if sid not in numbers:
                sentence = table[sid]
                numbers[sid] = len(citations) + 1
                located = SimpleNamespace(
                    cited_text=sentence.text,
                    start_char_index=sentence.start,
                    end_char_index=sentence.end,
                )
                entry = _citation(
                    numbers[sid], located, hits[sentence.chunk_index].chunk,
                    doc, doc_md, spans, elements,
                )
                entry["method"] = "similarity" if g.label == "similarity" else "id"
                entry["support"] = round(support, 4)
                citations.append(entry)
            if numbers[sid] not in refs:
                refs.append(numbers[sid])
        answer.append({"text": g.text, "citations": refs, "grounding": g.label})
    return answer, citations


def _stats(
    cited: int = 0, weak: int = 0, similarity: int = 0, none: int = 0, unknown_ids: int = 0
) -> dict[str, int]:
    return {
        "cited": cited,
        "weak": weak,
        "similarity": similarity,
        "none": none,
        "unknown_ids": unknown_ids,
    }


# --------------------------------------------------------------------------
# shared: one citation, located in the parsed document
# --------------------------------------------------------------------------


def _citation(n, c, chunk, doc, doc_md, spans, elements) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "n": n,
        "cited_text": c.cited_text,
        "chunk_id": chunk.id if chunk else None,
        "source_sha": doc.source_id,
        "doc_start": None,
        "doc_end": None,
        "page": None,
        "element_id": None,
        "bbox": None,
        "verified": False,
    }
    if chunk is None:
        return entry
    start = chunk.start_char + c.start_char_index
    end = chunk.start_char + c.end_char_index
    entry["doc_start"], entry["doc_end"] = start, end
    entry["verified"] = doc_md[start:end] == c.cited_text
    element_id = next((eid for eid, (s, e) in spans.items() if s <= start < e), None)
    if element_id is not None:
        element = elements[element_id]
        entry["element_id"] = element_id
        entry["page"] = element.page
        entry["bbox"] = list(element.bbox) if element.bbox else None
    return entry
