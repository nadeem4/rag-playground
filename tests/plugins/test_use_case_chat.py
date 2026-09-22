"""Tests for the `chat` use case (interface I-10).

Every test here talks to a fake client. The autouse guard in the root conftest
makes `make_client` raise unless a test patches it, so nothing in this file can
reach the network by accident. The one real call lives in
`test_live_api_round_trip`, behind `@pytest.mark.live_api` and a key in the
environment, and is deselected by default.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.artifacts import ArtifactType
from core.payloads import Hit, Output, ParsedDoc, RetrievalResult
from core.ports import RunContext, Stage
from core.registry import registry
from plugins.chunk.recursive_character import (
    RecursiveCharacterChunker,
    RecursiveCharacterConfig,
)
from plugins.parse.pdfium import PdfiumConfig, PdfiumParse
from plugins.use_case import chat as chat_module
from plugins.use_case.chat import ChatConfig, ChatUseCase
from tests.plugins.conftest import SAMPLE_PAGES, build_pdf

ROOT = Path(__file__).resolve().parents[2]
KEY = "sk-ant-test-SECRET-0123456789"
SHA = "abc123def4567890"


# --------------------------------------------------------------------------
# fakes and fixtures
# --------------------------------------------------------------------------


def text_block(text: str, *citations) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=text, citations=list(citations) or None)


def cite(cited_text: str, document_index: int, start: int, end: int) -> SimpleNamespace:
    return SimpleNamespace(
        type="char_location",
        cited_text=cited_text,
        document_index=document_index,
        document_title="t",
        start_char_index=start,
        end_char_index=end,
    )


def response(*blocks, stop_reason="end_turn", stop_details=None, model="claude-opus-5"):
    return SimpleNamespace(
        content=list(blocks),
        stop_reason=stop_reason,
        stop_details=stop_details,
        model=model,
        usage=SimpleNamespace(input_tokens=321, output_tokens=45),
    )


class FakeClient:
    """Records every request; returns a canned response or raises."""

    def __init__(self, reply=None, error: Exception | None = None):
        self.requests: list[dict] = []
        self.keys: list[str] = []
        self._reply = reply if reply is not None else response(text_block("ok"))
        self._error = error
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        if self._error is not None:
            raise self._error
        return self._reply


@pytest.fixture
def fake(monkeypatch):
    """Install a FakeClient behind `make_client`; set `.reply` / `.error` first."""
    holder = SimpleNamespace(client=None, reply=None, error=None)

    def make(api_key: str):
        holder.client = FakeClient(holder.reply, holder.error)
        holder.client.keys.append(api_key)
        return holder.client

    monkeypatch.setattr(chat_module, "make_client", make)
    return holder


@pytest.fixture
def pipeline(tmp_path):
    """A real ParsedDoc from the pdfium parser and a real chunk set cut from it."""
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    doc = PdfiumParse().apply(
        {"file": {"path": str(pdf), "sha": SHA, "filename": "sample.pdf"}},
        PdfiumConfig(),
        None,
    )
    chunks = RecursiveCharacterChunker().apply(
        {"doc": doc}, RecursiveCharacterConfig(chunk_size=70, chunk_overlap=0), None
    ).chunks
    return doc, chunks


def result_of(chunks, embed_text: str | None = None) -> dict:
    hits = []
    for rank, chunk in enumerate(chunks, start=1):
        if embed_text is not None:
            chunk = chunk.model_copy(update={"embed_text": embed_text})
        hits.append(Hit(chunk=chunk, score=1.0 / rank, rank=rank))
    return RetrievalResult(hits=hits, query_id="q" * 16).model_dump(mode="json")


def ctx(key: str | None = KEY) -> RunContext:
    extras = {"credentials": {"anthropic_api_key": key}} if key else {}
    return RunContext(output_dir=Path("."), emit=lambda e: None, tmp=Path("."), extras=extras)


QUESTION = "How is a document split?"


def run(pipeline, context=None, embed_text=None, **config) -> Output:
    doc, chunks = pipeline
    out = ChatUseCase().apply(
        {
            "result": result_of(chunks, embed_text),
            "query": {"text": QUESTION},
            "doc": doc,
        },
        ChatConfig(**config),
        context or ctx(),
    )
    return Output.model_validate(out)


# --------------------------------------------------------------------------
# declaration
# --------------------------------------------------------------------------


def test_registered_with_the_i10_ports():
    assert registry.get(Stage.USE_CASE, "chat") is ChatUseCase
    ports = ChatUseCase.inputs
    assert ports["result"].type is ArtifactType.RETRIEVAL_RESULT
    assert not ports["result"].ambient
    assert ports["query"].type is ArtifactType.QUERY and ports["query"].ambient
    assert ports["doc"].type is ArtifactType.PARSED_DOC and ports["doc"].ambient
    assert ChatUseCase.output is ArtifactType.OUTPUT


def test_never_cached_and_not_deterministic():
    assert ChatUseCase.cacheable is False
    assert ChatUseCase.deterministic is False


def test_config_defaults_and_model_choices():
    cfg = ChatConfig()
    assert cfg.model == "claude-opus-5" and cfg.max_chunks == 5
    for model in ("claude-sonnet-5", "claude-haiku-4-5"):
        assert ChatConfig(model=model).model == model
    with pytest.raises(Exception):
        ChatConfig(model="gpt-4")


def test_fingerprint_is_the_model_id():
    inst = ChatUseCase()
    assert inst.fingerprint() == "claude-opus-5"
    assert inst.fingerprint(ChatConfig(model="claude-haiku-4-5")) == "claude-haiku-4-5"


# --------------------------------------------------------------------------
# the request
# --------------------------------------------------------------------------


def test_documents_are_the_original_chunk_text_with_citations_enabled(fake, pipeline):
    run(pipeline, embed_text="AUGMENTED TEXT, NEVER SEND")
    req = fake.client.requests[0]
    content = req["messages"][0]["content"]
    docs = [b for b in content if b["type"] == "document"]
    _, chunks = pipeline
    assert [d["source"]["data"] for d in docs] == [c.text for c in chunks]
    for d, c in zip(docs, chunks):
        assert d["source"] == {"type": "text", "media_type": "text/plain", "data": c.text}
        assert d["citations"] == {"enabled": True}
        assert d["title"] == f"p.{c.page_span[0]} chunk {c.ordinal}"
    assert "AUGMENTED" not in json.dumps(req)
    # Documents first, then the question.
    assert content[-1] == {"type": "text", "text": QUESTION}
    # Citations are incompatible with structured outputs.
    assert "format" not in (req.get("output_config") or {})
    assert "only" in req["system"].lower()


def test_max_chunks_caps_the_documents(fake, pipeline):
    run(pipeline, max_chunks=2)
    content = fake.client.requests[0]["messages"][0]["content"]
    assert sum(b["type"] == "document" for b in content) == 2


def test_reads_only_the_top_max_chunks_of_a_wide_pool(fake, pipeline):
    """A retriever hands on 20; chat must read only the best `max_chunks`."""
    doc, chunks = pipeline
    pool = [chunks[i % len(chunks)] for i in range(20)]
    ChatUseCase().apply(
        {"result": result_of(pool), "query": {"text": QUESTION}, "doc": doc},
        ChatConfig(),
        ctx(),
    )
    content = fake.client.requests[0]["messages"][0]["content"]
    sent = [b["source"]["data"] for b in content if b["type"] == "document"]
    assert sent == [c.text for c in pool[:5]]


def test_the_key_reaches_the_factory(fake, pipeline):
    run(pipeline)
    assert fake.client.keys == [KEY]


def test_opus_5_request_uses_default_server_side_fallbacks(fake, pipeline):
    run(pipeline)
    req = fake.client.requests[0]
    assert req["model"] == "claude-opus-5"
    assert req["fallbacks"] == "default"
    assert req["betas"] == ["server-side-fallback-2026-07-01"]
    assert req["thinking"] == {"type": "adaptive"}
    assert req["max_tokens"] == 16000


@pytest.mark.parametrize("model", ["claude-sonnet-5", "claude-haiku-4-5"])
def test_other_models_get_no_fallbacks(fake, pipeline, model):
    run(pipeline, model=model)
    req = fake.client.requests[0]
    assert req["model"] == model
    assert "fallbacks" not in req and "betas" not in req


def test_haiku_gets_no_adaptive_thinking(fake, pipeline):
    run(pipeline, model="claude-haiku-4-5")
    assert "thinking" not in fake.client.requests[0]


# --------------------------------------------------------------------------
# citation mapping
# --------------------------------------------------------------------------


def chunk2(pipeline):
    _, chunks = pipeline
    chunk = next(c for c in chunks if c.ordinal == 2)
    return chunks.index(chunk), chunk


def test_citation_maps_to_document_offsets_and_verifies(fake, pipeline):
    doc, _ = pipeline
    index, chunk = chunk2(pipeline)
    quoted = "a document into passages"
    start = chunk.text.index(quoted)
    fake.reply = response(text_block("It is split into passages", cite(quoted, index, start, start + len(quoted))))

    out = run(pipeline)
    [c] = out.payload["citations"]

    assert c["doc_start"] == chunk.start_char + start
    assert c["doc_end"] == chunk.start_char + start + len(quoted)
    assert c["verified"] is True
    assert c["chunk_id"] == chunk.id
    assert c["source_sha"] == SHA
    assert c["cited_text"] == quoted
    assert c["n"] == 1

    parsed = ParsedDoc.model_validate(doc)
    element = next(e for e in parsed.elements if quoted in e.text)
    assert c["element_id"] == element.id
    assert c["page"] == element.page == 2
    assert c["bbox"] == list(element.bbox)


def test_citation_with_wrong_indices_is_kept_unverified(fake, pipeline):
    index, chunk = chunk2(pipeline)
    quoted = "a document into passages"
    fake.reply = response(text_block("claim", cite(quoted, index, 0, 5)))

    [c] = run(pipeline).payload["citations"]
    assert c["verified"] is False
    assert c["cited_text"] == quoted


def test_identical_citations_share_a_number(fake, pipeline):
    index, chunk = chunk2(pipeline)
    same = cite("Chunking", index, 0, 8)
    other = cite("passages", index, 32, 40)
    fake.reply = response(
        text_block("A", same),
        text_block(" and "),
        text_block("B", other, cite("Chunking", index, 0, 8)),
        text_block("C", cite("Chunking", index, 0, 8)),
    )
    out = run(pipeline)
    assert [c["n"] for c in out.payload["citations"]] == [1, 2]
    # I-20: native segments carry `grounding: None`.
    assert out.payload["answer"] == [
        {"text": "A", "citations": [1], "grounding": None},
        {"text": " and ", "citations": [], "grounding": None},
        {"text": "B", "citations": [2, 1], "grounding": None},
        {"text": "C", "citations": [1], "grounding": None},
    ]


def test_answer_preserves_uncited_segments_in_order(fake, pipeline):
    index, _ = chunk2(pipeline)
    fake.reply = response(
        SimpleNamespace(type="thinking", thinking="", signature="s"),
        text_block("According to the text, "),
        text_block("chunking splits documents", cite("Chunking", index, 0, 8)),
        text_block("."),
    )
    payload = run(pipeline).payload
    assert "".join(s["text"] for s in payload["answer"]) == (
        "According to the text, chunking splits documents."
    )
    assert [s["citations"] for s in payload["answer"]] == [[], [1], []]
    assert payload["question"] == QUESTION
    assert payload["model"] == "claude-opus-5"
    assert payload["usage"] == {"input_tokens": 321, "output_tokens": 45}
    assert payload["stop_reason"] == "end_turn"


def test_output_kind_is_chat(fake, pipeline):
    assert run(pipeline).kind == "chat"


# --------------------------------------------------------------------------
# refusal, missing key, errors, secrecy
# --------------------------------------------------------------------------


def test_refusal_is_an_honest_successful_payload(fake, pipeline):
    fake.reply = response(
        stop_reason="refusal",
        stop_details=SimpleNamespace(type="refusal", category="cyber", explanation=None),
    )
    payload = run(pipeline).payload
    assert payload["stop_reason"] == "refusal"
    assert payload["citations"] == []
    [segment] = payload["answer"]
    assert "declined" in segment["text"] and "cyber" in segment["text"]
    assert segment["citations"] == []


def test_refusal_without_stop_details(fake, pipeline):
    fake.reply = response(stop_reason="refusal", stop_details=None)
    [segment] = run(pipeline).payload["answer"]
    assert "declined" in segment["text"]


@pytest.mark.parametrize("extras", [{}, {"credentials": {}}, {"credentials": {"anthropic_api_key": ""}}])
def test_missing_key_is_a_readable_error(fake, pipeline, extras):
    context = RunContext(output_dir=Path("."), emit=lambda e: None, tmp=Path("."), extras=extras)
    with pytest.raises(ValueError) as info:
        run(pipeline, context=context)
    assert str(info.value) == (
        "No Anthropic API key. Add one in the UI (API key, top right) "
        "or put ANTHROPIC_API_KEY in .env."
    )
    assert fake.client is None


def test_key_never_appears_in_the_payload(fake, pipeline):
    index, _ = chunk2(pipeline)
    fake.reply = response(text_block("x", cite("Chunking", index, 0, 8)))
    out = run(pipeline)
    assert KEY not in json.dumps(out.model_dump(mode="json"))


def _api_errors():
    import anthropic
    import httpx2

    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")

    def status(cls, code):
        return cls(
            f"bad key {KEY}",
            response=httpx2.Response(code, request=request),
            body={"error": {"message": f"echo {KEY}"}},
        )

    return [
        status(anthropic.AuthenticationError, 401),
        status(anthropic.PermissionDeniedError, 403),
        status(anthropic.NotFoundError, 404),
        status(anthropic.RateLimitError, 429),
        status(anthropic.BadRequestError, 400),
        status(anthropic.InternalServerError, 500),
        anthropic.APIConnectionError(message=f"conn {KEY}", request=request),
    ]


@pytest.mark.parametrize("error", _api_errors(), ids=lambda e: type(e).__name__)
def test_api_errors_are_readable_and_never_carry_the_key(fake, pipeline, error):
    fake.error = error
    with pytest.raises(RuntimeError) as info:
        run(pipeline)
    exc = info.value
    assert KEY not in str(exc)
    assert exc.__cause__ is None and exc.__suppress_context__
    import traceback

    assert KEY not in "".join(traceback.format_exception(exc))


def test_importing_the_plugin_does_not_import_the_sdk():
    code = (
        "import sys\n"
        "import plugins\n"
        "plugins.discover()\n"
        "import plugins.use_case.chat\n"
        "leaked = sorted(m for m in sys.modules if m.split('.')[0] == 'anthropic')\n"
        "print(leaked)\n"
        "sys.exit(1 if leaked else 0)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_guard_blocks_unpatched_clients(pipeline):
    """Without `fake`, the autouse guard stands in for `make_client`."""
    with pytest.raises(AssertionError, match="live_api"):
        run(pipeline)


# --------------------------------------------------------------------------
# the one real call (deselected by default)
# --------------------------------------------------------------------------


@pytest.mark.live_api
def test_live_api_round_trip(pipeline):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        pytest.skip("ANTHROPIC_API_KEY is not set")
    out = run(pipeline, context=ctx(key), model="claude-haiku-4-5")
    assert out.payload["stop_reason"] in {"end_turn", "refusal", "max_tokens"}
    assert key not in json.dumps(out.model_dump(mode="json"))
