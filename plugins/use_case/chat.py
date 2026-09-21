"""Chat: an answer from Claude in which every claim points at its source.

Each retrieved chunk goes to the Messages API as a plain-text `document` block
with citations enabled. Claude answers in `text` blocks, and the cited ones
carry `char_location` citations: character offsets *into that chunk*. Adding the
chunk's `start_char` turns them into offsets into the parsed document's rendered
markdown, which is what the chunker cut from. From there the element whose span
contains the start gives the page and the bbox the PDF viewer highlights.

Three rules carry the design:

- **The original text, never `embed_text`.** A citation that quotes an
  augmentation (contextual retrieval, propositions) is a fabricated quote.
- **Verify, never drop.** `doc_md[doc_start:doc_end] == cited_text` is checked
  for every citation. A failure is kept with `verified: false`, because the UI
  must show that the grounding is broken rather than silently lose it.
- **The key is a secret.** It arrives in `ctx.extras["credentials"]` (I-8), is
  handed to the client factory and to nothing else, and any SDK error is
  re-raised as a fresh message with the key scrubbed and the original chain
  dropped, so it cannot surface in a traceback.

The SDK is imported lazily, inside `make_client` and `apply`, so registering the
plugin (every API start, every test run) costs nothing.

**API call shape**, per the claude-api skill: non-streaming
`client.beta.messages.create` with `max_tokens=16000` (the skill's non-streaming
default; a grounded answer is short, and the node returns one payload so there
is nothing to stream to). Adaptive thinking on the models that support it. On
`claude-opus-5`, server-side fallbacks in their `"default"` mode, which reroute
a safety-classifier refusal by category; the skill documents them only for
Opus 5 and Fable 5.1, so Sonnet 5 and Haiku 4.5 are sent without. No
`output_config.format`: citations and structured outputs are a 400 together.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import Hit, Output, ParsedDoc, Query, RetrievalResult
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Transform

NO_KEY_MESSAGE = (
    "No Anthropic API key. Add one in the UI (API key, top right) "
    "or put ANTHROPIC_API_KEY in .env."
)

SYSTEM_PROMPT = (
    "Answer the user's question using only the provided documents. "
    "If the documents do not contain the answer, say so plainly instead of "
    "guessing or drawing on outside knowledge. Be concise."
)

#: Enough room for adaptive thinking plus a short answer, and within the
#: skill's ceiling for a non-streaming request.
MAX_TOKENS = 16000

#: Models the skill documents server-side fallbacks for, with their settings.
_FALLBACKS: dict[str, dict[str, Any]] = {
    "claude-opus-5": {
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    },
}

#: Haiku 4.5 predates adaptive thinking (it takes `budget_tokens`).
_ADAPTIVE_THINKING = {"claude-opus-5", "claude-sonnet-5"}


class ChatConfig(BaseModel):
    model: Literal["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] = (
        "claude-opus-5"
    )
    max_chunks: int = Field(default=5, ge=1)


def make_client(api_key: str) -> Any:
    """The one place a real client is built. Tests monkeypatch this."""
    import anthropic

    return anthropic.Anthropic(api_key=api_key)


@register
class ChatUseCase(Transform[ChatConfig]):
    """`retrieval_result (+ query, parsed_doc) -> output`."""

    name = "chat"
    version = "1"
    stage = Stage.USE_CASE
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
        "doc": PortSpec(ArtifactType.PARSED_DOC, ambient=True),
    }
    output = ArtifactType.OUTPUT
    config_model = ChatConfig

    #: A generation, not a function of its inputs: replaying a cached answer
    #: would make asking twice look deterministic when it is not.
    cacheable = False
    deterministic = False

    def fingerprint(self, config: ChatConfig | None = None) -> str:
        return (config or ChatConfig()).model

    def apply(
        self, inputs: Mapping[str, Any], config: ChatConfig, ctx: RunContext
    ) -> dict[str, Any]:
        api_key = (ctx.extras.get("credentials") or {}).get("anthropic_api_key")
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
            **_FALLBACKS.get(config.model, {}),
        }
        if config.model in _ADAPTIVE_THINKING:
            request["thinking"] = {"type": "adaptive"}

        response = _call(make_client(api_key), request, api_key)

        payload: dict[str, Any] = {
            "question": question,
            "model": getattr(response, "model", None) or config.model,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
            },
            "stop_reason": response.stop_reason,
        }
        # Check the stop reason before reading content: a refusal may come with
        # no content at all, or with a partial answer that must not be shown.
        if response.stop_reason == "refusal":
            payload["answer"] = [{"text": _declined(response), "citations": []}]
            payload["citations"] = []
        else:
            payload["answer"], payload["citations"] = _ground(
                response.content, hits, doc
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


def _call(client: Any, request: dict[str, Any], api_key: str) -> Any:
    """Send the request; turn SDK errors into readable, key-free messages.

    Most specific first, as the skill prescribes. `from None` drops the SDK
    exception from the chain: it holds the request, and the request holds the
    key.
    """
    import anthropic

    def fail(message: str) -> RuntimeError:
        return RuntimeError(message.replace(api_key, "[redacted]"))

    try:
        return client.beta.messages.create(**request)
    except anthropic.AuthenticationError:
        raise fail("Anthropic rejected the API key (401). Check the key.") from None
    except anthropic.PermissionDeniedError:
        raise fail("The API key may not use this model (403).") from None
    except anthropic.NotFoundError:
        raise fail(f"Model {request['model']} was not found (404).") from None
    except anthropic.RateLimitError:
        raise fail("Rate limited by the Anthropic API (429). Retry shortly.") from None
    except anthropic.BadRequestError as e:
        raise fail(f"The Anthropic API rejected the request (400): {e.message}") from None
    except anthropic.APIStatusError as e:
        raise fail(f"Anthropic API error ({e.status_code}): {e.message}") from None
    except anthropic.APIConnectionError:
        raise fail("Could not reach the Anthropic API. Check the network.") from None


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
                citations.append(
                    _citation(numbers[key], c, chunk, doc, doc_md, spans, elements)
                )
            if numbers[key] not in refs:
                refs.append(numbers[key])
        answer.append({"text": block.text, "citations": refs})
    return answer, citations


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
