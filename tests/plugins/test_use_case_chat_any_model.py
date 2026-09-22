"""Chat with any model (I-16 to I-20): config, explanation, both citation paths.

Every client is a fake: the root conftest refuses to build a real one. The
index is a descriptor naming the `fake-deterministic` embedder, so the support
check runs for real with no model download.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.artifacts import ArtifactType
from core.payloads import Output, ParsedDoc
from core.ports import RunContext
from plugins.use_case import chat as chat_module
from plugins.use_case._grounding import number_sources
from plugins.use_case.chat import SENTENCE_PROMPT, ChatConfig, ChatUseCase
from providers import llm
from tests.plugins.test_rerank import write_index
from tests.plugins.test_use_case_chat import (  # noqa: F401  (fixtures)
    KEY,
    QUESTION,
    SHA,
    cite,
    fake,
    pipeline,
    response,
    result_of,
    text_block,
)

OPENAI_KEY = "sk-openai-test-SECRET-0123456789"
CUSTOM_KEY = "custom-test-SECRET-0123456789"


def context(**keys) -> RunContext:
    creds = {"anthropic_api_key": KEY, "openai_api_key": OPENAI_KEY} | keys
    creds = {k: v for k, v in creds.items() if v}
    return RunContext(
        output_dir=Path("."), emit=lambda e: None, tmp=Path("."),
        extras={"credentials": creds},
    )


@pytest.fixture
def index(tmp_path) -> str:
    return str(write_index(tmp_path / "index"))


def ask(pipeline, index=None, ctx=None, **config) -> Output:
    doc, chunks = pipeline
    inputs = {"result": result_of(chunks), "query": {"text": QUESTION}, "doc": doc}
    if index is not None:
        inputs["index"] = index
    out = ChatUseCase().apply(inputs, ChatConfig(**config), ctx or context())
    return Output.model_validate(out)


class FakeOpenAI:
    """Answers with `answer(user_prompt, table)`; records every request."""

    def __init__(self, answer):
        self.requests: list[dict] = []
        self._answer = answer
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        text = self._answer(kwargs["messages"][1]["content"])
        return SimpleNamespace(
            choices=[SimpleNamespace(
                message=SimpleNamespace(content=text, refusal=None), finish_reason="stop"
            )],
            usage=SimpleNamespace(prompt_tokens=500, completion_tokens=60),
        )


@pytest.fixture
def openai_fake(monkeypatch):
    holder = SimpleNamespace(client=None, answer=lambda prompt: "Nothing here.", built=[])

    def make(api_key, base_url=None):
        holder.built.append({"api_key": api_key, "base_url": base_url})
        holder.client = FakeOpenAI(holder.answer)
        return holder.client

    monkeypatch.setattr(llm, "make_openai_client", make)
    return holder


def table_for(pipeline, max_chunks=5):
    _, chunks = pipeline
    return number_sources(chunks[:max_chunks])[1]


def sid_containing(table, phrase: str) -> str:
    return next(sid for sid, s in table.items() if phrase in s.text)


# --- config -------------------------------------------------------------------


def test_config_defaults():
    cfg = ChatConfig()
    assert cfg.model == "claude-opus-5"
    assert cfg.custom_base_url == "" and cfg.custom_model == ""
    assert cfg.citation_method == "auto"
    assert cfg.support_threshold == 0.55
    assert cfg.max_chunks == 5


def test_model_choices_are_the_registry():
    for model_id in llm.CHAT_MODELS:
        assert ChatConfig(model=model_id).model == model_id
    with pytest.raises(Exception):
        ChatConfig(model="gpt-4")


@pytest.mark.parametrize("value", [-0.1, 1.1])
def test_threshold_is_between_0_and_1(value):
    with pytest.raises(Exception):
        ChatConfig(support_threshold=value)


def test_schema_carries_labels_and_show_when():
    props = ChatConfig.model_json_schema()["properties"]
    assert props["model"]["x-labels"] == {m.id: m.label for m in llm.CHAT_MODELS.values()}
    for name in ("custom_base_url", "custom_model"):
        assert props[name]["x-show-when"] == {"model": "custom"}


def test_declares_an_ambient_index_port():
    port = ChatUseCase.inputs["index"]
    assert port.type is ArtifactType.INDEX and port.ambient


# --- explain ------------------------------------------------------------------


def explain(**config):
    exp = ChatUseCase().explain(ChatConfig(**config))
    return exp, exp.settings + " " + (exp.tradeoff or "")


def test_explain_native_for_claude_on_auto():
    exp, text = explain()
    assert "Claude's own citations" in text
    assert not exp.blocking


def test_explain_sentence_ids_for_openai_on_auto():
    _, text = explain(model="gpt-6-astra")
    assert "GPT-6 Astra" in text and "sentence id" in text
    assert "OPENAI_API_KEY" in text
    assert "0.55" in text


def test_explain_sentence_ids_chosen_for_claude():
    _, text = explain(citation_method="sentence_ids", support_threshold=0.7)
    assert "sentence id" in text and "0.7" in text
    assert "ANTHROPIC_API_KEY" in text


@pytest.mark.parametrize(
    "base_url,model_name", [("", ""), ("http://localhost:11434/v1", ""), ("", "llama3.3")]
)
def test_explain_blocks_an_incomplete_custom_endpoint(base_url, model_name):
    exp, _ = explain(model="custom", custom_base_url=base_url, custom_model=model_name)
    assert exp.blocking and "base URL" in exp.warning


def test_explain_a_complete_custom_endpoint():
    exp, text = explain(
        model="custom", custom_base_url="http://localhost:11434/v1", custom_model="llama3.3"
    )
    assert not exp.blocking
    assert "llama3.3" in text and "http://localhost:11434/v1" in text
    assert "optional" in text


def test_explanations_have_no_em_dashes():
    for model_id in llm.CHAT_MODELS:
        for method in ("auto", "sentence_ids"):
            exp, text = explain(model=model_id, citation_method=method)
            assert "\N{EM DASH}" not in text + (exp.warning or "")


# --- the native path, with the additive I-20 fields ---------------------------


def test_native_path_adds_provider_method_and_stats(fake, pipeline):
    _, chunks = pipeline
    index = next(i for i, c in enumerate(chunks) if c.ordinal == 2)
    fake.reply = response(
        text_block("Chunking splits it", cite("Chunking", index, 0, 8)),
        text_block(". "),
        text_block("An uncited claim."),
    )
    payload = ask(pipeline).payload
    assert payload["provider"] == "anthropic"
    assert payload["citation_method"] == "native"
    assert payload["stats"] == {
        "cited": 1, "weak": 0, "similarity": 0, "none": 1, "unknown_ids": 0,
    }
    assert all(seg["grounding"] is None for seg in payload["answer"])
    [c] = payload["citations"]
    assert c["method"] == "native" and c["support"] is None
    # The native request is untouched: document blocks, no index needed.
    assert any(b["type"] == "document" for b in fake.client.requests[0]["messages"][0]["content"])


# --- the sentence-id path -----------------------------------------------------


def test_openai_end_to_end_citation_slices_the_document(openai_fake, pipeline, index):
    doc, _ = pipeline
    table = table_for(pipeline)
    sid = sid_containing(table, "passages")
    sentence = table[sid]
    openai_fake.answer = lambda prompt: f"{sentence.text} [{sid}]"

    payload = ask(pipeline, index=index, model="gpt-6-astra").payload

    [req] = openai_fake.client.requests
    assert req["model"] == "gpt-6-astra"
    assert req["messages"][0] == {"role": "system", "content": SENTENCE_PROMPT}
    assert f"[{sid}] " in req["messages"][1]["content"]
    assert QUESTION in req["messages"][1]["content"]
    assert openai_fake.built == [{"api_key": OPENAI_KEY, "base_url": None}]

    assert payload["provider"] == "openai"
    assert payload["citation_method"] == "sentence_ids"
    assert payload["model"] == "gpt-6-astra"
    assert payload["usage"] == {"input_tokens": 500, "output_tokens": 60}
    assert payload["stop_reason"] == "stop"
    assert payload["answer"] == [
        {"text": sentence.text, "citations": [1], "grounding": "cited"}
    ]
    [c] = payload["citations"]
    doc_md, _ = ParsedDoc.model_validate(doc).render_markdown()
    assert doc_md[c["doc_start"] : c["doc_end"]] == sentence.text == c["cited_text"]
    assert c["verified"] is True
    assert c["method"] == "id" and c["support"] == pytest.approx(1.0)
    assert c["page"] is not None and c["bbox"] and c["element_id"]
    assert c["source_sha"] == SHA
    _, chunks = pipeline
    assert c["chunk_id"] == chunks[sentence.chunk_index].id
    assert payload["stats"] == {
        "cited": 1, "weak": 0, "similarity": 0, "none": 0, "unknown_ids": 0,
    }


def test_every_label_and_unknown_ids(openai_fake, pipeline, index):
    table = table_for(pipeline)
    ids = list(table)
    a, b, c = ids[0], ids[-1], ids[len(ids) // 2]
    ta, tc = table[a].text, table[c].text
    openai_fake.answer = lambda prompt: (
        f"{ta} [{a}]. "  # cited
        f"{ta} [{b}]. "  # weak: the id points at an unrelated sentence
        "Zebras quietly juggle violet xylophones [9.9]. "  # none, plus an unknown id
        f"{tc}"  # similarity: no id, but it is a shown sentence
    )
    payload = ask(pipeline, index=index, model="gpt-5.6-sol").payload
    labels = [s["grounding"] for s in payload["answer"]]
    assert labels == ["cited", "weak", "none", "similarity"]
    assert payload["stats"] == {
        "cited": 1, "weak": 1, "similarity": 1, "none": 1, "unknown_ids": 1,
    }
    by_label = {s["grounding"]: s for s in payload["answer"] if s["grounding"]}
    methods = {c["n"]: c["method"] for c in payload["citations"]}
    assert [methods[n] for n in by_label["cited"]["citations"]] == ["id"]
    assert [methods[n] for n in by_label["weak"]["citations"]] == ["id"]
    assert [methods[n] for n in by_label["similarity"]["citations"]] == ["similarity"]
    assert by_label["none"]["citations"] == []
    # The weak citation keeps its low support; the cited one is high.
    support = {c["n"]: c["support"] for c in payload["citations"]}
    assert support[by_label["weak"]["citations"][0]] < 0.55
    assert support[by_label["cited"]["citations"][0]] >= 0.55
    # Each sentence gets one number.
    assert len({(c["doc_start"], c["doc_end"]) for c in payload["citations"]}) == len(
        payload["citations"]
    )
    assert "[" not in "".join(s["text"] for s in payload["answer"])


def test_the_threshold_moves_cited_to_weak(openai_fake, pipeline, index):
    table = table_for(pipeline)
    sid = sid_containing(table, "passages")
    words = table[sid].text.split()
    # Half the words: similar, not identical.
    openai_fake.answer = lambda prompt: " ".join(words[: len(words) // 2]) + f" [{sid}]"
    low = ask(pipeline, index=index, model="gpt-6-astra", support_threshold=0.05)
    high = ask(pipeline, index=index, model="gpt-6-astra", support_threshold=0.99)
    assert low.payload["answer"][0]["grounding"] == "cited"
    assert high.payload["answer"][0]["grounding"] == "weak"


def test_claude_with_sentence_ids_uses_complete(monkeypatch, pipeline, index):
    table = table_for(pipeline)
    sid = next(iter(table))
    requests: list[dict] = []

    def create(**kwargs):
        requests.append(kwargs)
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=f"{table[sid].text} [{sid}]")],
            stop_reason="end_turn",
            usage=SimpleNamespace(input_tokens=10, output_tokens=5),
            model="claude-opus-5",
        )

    monkeypatch.setattr(
        llm, "make_anthropic_client",
        lambda api_key: SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create))),
    )
    payload = ask(pipeline, index=index, citation_method="sentence_ids").payload
    [req] = requests
    assert req["system"] == SENTENCE_PROMPT
    assert isinstance(req["messages"][0]["content"], str)  # no document blocks
    assert payload["provider"] == "anthropic"
    assert payload["citation_method"] == "sentence_ids"
    assert payload["answer"][0]["grounding"] == "cited"


def test_custom_endpoint_uses_its_url_model_and_optional_key(openai_fake, pipeline, index):
    base = "http://localhost:11434/v1"
    out = ask(
        pipeline, index=index, ctx=context(custom_api_key=CUSTOM_KEY),
        model="custom", custom_base_url=base, custom_model="llama3.3",
    )
    assert openai_fake.built == [{"api_key": CUSTOM_KEY, "base_url": base}]
    assert openai_fake.client.requests[0]["model"] == "llama3.3"
    assert out.payload["provider"] == "openai_compatible"
    assert out.payload["model"] == "llama3.3"
    # No key at all is fine for a local server.
    ask(pipeline, index=index, ctx=context(openai_api_key=None, anthropic_api_key=None),
        model="custom", custom_base_url=base, custom_model="llama3.3")
    assert openai_fake.built[-1]["api_key"] == "not-needed"


def test_custom_endpoint_never_gets_the_openai_key(openai_fake, pipeline, index):
    ask(pipeline, index=index, model="custom",
        custom_base_url="http://localhost:1/v1", custom_model="m")
    assert OPENAI_KEY not in json.dumps(openai_fake.built)


def test_incomplete_custom_endpoint_fails_readably(openai_fake, pipeline, index):
    with pytest.raises(ValueError, match="base URL"):
        ask(pipeline, index=index, model="custom", custom_model="m")
    assert openai_fake.built == []


def test_missing_openai_key_names_the_key(openai_fake, pipeline, index):
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        ask(pipeline, index=index, ctx=context(openai_api_key=None), model="gpt-6-astra")
    assert openai_fake.built == []


def test_sentence_ids_need_an_index(openai_fake, pipeline):
    with pytest.raises(ValueError, match="index"):
        ask(pipeline, model="gpt-6-astra")


def test_a_refusal_is_one_ungrounded_segment(monkeypatch, pipeline, index):
    class Refuser(FakeOpenAI):
        def _create(self, **kwargs):
            return SimpleNamespace(
                choices=[SimpleNamespace(
                    message=SimpleNamespace(content=None, refusal="I can't help."),
                    finish_reason="stop",
                )],
                usage=None,
            )

    monkeypatch.setattr(llm, "make_openai_client", lambda *a, **k: Refuser(None))
    payload = ask(pipeline, index=index, model="gpt-6-astra").payload
    assert payload["stop_reason"] == "refusal"
    assert payload["answer"] == [{"text": "I can't help.", "citations": [], "grounding": None}]
    assert payload["citations"] == []
    assert payload["stats"] == {
        "cited": 0, "weak": 0, "similarity": 0, "none": 0, "unknown_ids": 0,
    }


def test_no_key_ever_reaches_the_payload(openai_fake, pipeline, index):
    table = table_for(pipeline)
    sid = next(iter(table))
    openai_fake.answer = lambda prompt: f"{table[sid].text} [{sid}]"
    out = ask(pipeline, index=index, ctx=context(custom_api_key=CUSTOM_KEY), model="gpt-6-astra")
    blob = json.dumps(out.model_dump(mode="json"))
    for key in (KEY, OPENAI_KEY, CUSTOM_KEY):
        assert key not in blob


def test_the_plugin_module_still_imports_no_sdk():
    assert not hasattr(chat_module, "openai") and not hasattr(chat_module, "anthropic")
