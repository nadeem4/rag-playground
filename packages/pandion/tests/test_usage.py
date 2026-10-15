"""Token usage per step: what a model step spent, on its result and its event.

A model step records usage with `set_usage`. The executor copies it into the
`node_finished` event and the pipeline into `StageResult.usage`. A cached step
spent nothing in this run, so its usage is None, whatever the stored meta says.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from pandion import Pipeline, llm
from pandion.artifacts import ArtifactType
from pandion.executor import run
from pandion.extend import PortSpec, RunContext, Stage, Transform, register, set_note, set_usage
from pandion.graph import Edge, Graph, Node
from pandion.llm import CHAT_MODELS, Completion, complete
from pandion.plugins.answer import chat as chat_plugin
from pandion.registry import Registry
from pandion.storage import Store
from fakes import EmptyCfg, _make
from pdfs import SAMPLE_PAGES, build_pdf

QUESTION = "What is the capital of France?"
CREDS = {"openai_api_key": "sk-test", "anthropic_api_key": "sk-ant-test"}

INDEX = """\
path: ./index
models:
  device: cpu
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character, chunk_size: 70, chunk_overlap: 10}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
"""


def built(tmp_path: Path, rest: str) -> Pipeline:
    config = tmp_path / "pipeline.yaml"
    config.write_text(INDEX + rest, encoding="utf-8")
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    p = Pipeline.from_yaml(config)
    assert p.index.run(docs).ok
    return p


def ctx(tmp_path) -> RunContext:
    return RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)


# -- set_usage ---------------------------------------------------------------------


def test_set_usage_writes_the_counts_and_the_model_into_meta(tmp_path):
    run_ctx = ctx(tmp_path)
    set_note(run_ctx, "A note.")
    set_usage(run_ctx, {"input_tokens": 12, "output_tokens": 3}, "gpt-6-astra")
    assert run_ctx.extras["meta"] == {
        "note": "A note.",
        "usage": {"input_tokens": 12, "output_tokens": 3, "model": "gpt-6-astra"},
    }


def test_set_usage_keeps_a_missing_count_as_none_never_zero(tmp_path):
    run_ctx = ctx(tmp_path)
    set_usage(run_ctx, {"input_tokens": None}, "local-model")
    assert run_ctx.extras["meta"]["usage"] == {
        "input_tokens": None, "output_tokens": None, "model": "local-model",
    }


def test_set_usage_tolerates_no_context():
    set_usage(None, {"input_tokens": 1, "output_tokens": 1}, "m")


# -- a server that sends no usage -----------------------------------------------------


def _openai_reply(usage):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="ok", refusal=None), finish_reason="stop")],
        usage=usage,
    )


@pytest.mark.parametrize(
    "usage, expected",
    [
        (None, {"input_tokens": None, "output_tokens": None}),
        (SimpleNamespace(prompt_tokens=7, completion_tokens=None), {"input_tokens": 7, "output_tokens": None}),
    ],
)
def test_a_custom_server_without_usage_gives_none_not_zero(monkeypatch, usage, expected):
    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: _openai_reply(usage)))
    )
    monkeypatch.setattr(llm, "make_openai_client", lambda *a, **kw: client)
    out = complete(
        CHAT_MODELS["custom"], system="s", user="u", api_key=None,
        base_url="http://localhost:11434/v1", model_name="llama3",
    )
    assert out.usage == expected


# -- the three model steps ---------------------------------------------------------------


def test_each_model_step_reports_what_its_call_spent(tmp_path, monkeypatch):
    spent = {
        "rewrite": {"input_tokens": 10, "output_tokens": 1},
        "rerank": {"input_tokens": 20, "output_tokens": 2},
        "answer": {"input_tokens": 30, "output_tokens": 3},
    }

    def fake(model, **kwargs):
        if kwargs["system"] == chat_plugin.SENTENCE_PROMPT:
            step, text = "answer", "Paris is the capital of France [1.1]."
        elif "search words" in kwargs["system"]:
            step, text = "rewrite", "capital France Paris"
        else:
            step, text = "rerank", "2, 1"
        return Completion(text=text, usage=dict(spent[step]), stop_reason="end_turn")

    monkeypatch.setattr(llm, "complete", fake)
    p = built(
        tmp_path,
        "retrieve:\n"
        "  rewrite: {use: llm_rewrite, style: keywords, model: gpt-6-astra}\n"
        "  search: {use: bm25, top_k: 4}\n"
        "  rerank: {use: llm_rerank, top_k: 2, model: gpt-5.6-sol}\n"
        "answer: {use: chat, model: gpt-6-astra}\n",
    )

    answer = p.ask(QUESTION, credentials=CREDS)

    assert answer.ok, answer.stages["answer"].error
    assert answer.stages["rewrite"].usage == {**spent["rewrite"], "model": "gpt-6-astra"}
    assert answer.stages["rerank"][0].usage == {**spent["rerank"], "model": "gpt-5.6-sol"}
    assert answer.stages["answer"].usage == {**spent["answer"], "model": "gpt-6-astra"}
    # Steps that call no model have no usage.
    assert answer.stages["search"].usage is None


def test_the_native_citations_path_reports_its_usage(tmp_path, monkeypatch):
    response = SimpleNamespace(
        model="claude-sonnet-5",
        content=[SimpleNamespace(type="text", text="Paris.", citations=None)],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=200, output_tokens=40),
    )
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: response)))
    monkeypatch.setattr(chat_plugin, "make_client", lambda key: client)
    p = built(tmp_path, "retrieve:\n  search: {use: bm25}\nanswer: {use: chat, model: claude-sonnet-5}\n")

    answer = p.ask(QUESTION, credentials=CREDS)

    assert answer.ok, answer.stages["answer"].error
    assert answer.stages["answer"].usage == {
        "input_tokens": 200, "output_tokens": 40, "model": "claude-sonnet-5",
    }


def test_the_rewrite_function_reports_usage(monkeypatch):
    import pandion

    monkeypatch.setattr(
        llm, "complete",
        lambda model, **kw: Completion(text="capital France", usage={"input_tokens": 5, "output_tokens": 2}, stop_reason="end_turn"),
    )
    result = pandion.rewrite(QUESTION, use="llm_rewrite", model="gpt-6-astra", credentials=CREDS)
    assert result.usage == {"input_tokens": 5, "output_tokens": 2, "model": "gpt-6-astra"}


# -- a cached step spent nothing in this run --------------------------------------------


@pytest.fixture
def usage_rerank():
    """A cacheable rerank step that records usage; removed after the test."""

    @register
    class UsageRerank(Transform[EmptyCfg]):
        name = "test_usage_rerank"
        stage = Stage.RERANK
        inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = EmptyCfg
        summary = "Keeps the order and records made-up usage."

        def apply(self, inputs, config, ctx):
            set_usage(ctx, {"input_tokens": 9, "output_tokens": 4}, "made-up")
            return inputs["result"]

    yield
    from pandion.registry import registry

    registry._by_stage[Stage.RERANK].pop("test_usage_rerank", None)


def test_a_cached_step_has_no_usage(tmp_path, usage_rerank):
    p = built(tmp_path, "retrieve:\n  search: {use: bm25}\n  rerank: {use: test_usage_rerank}\n")

    first = p.retrieve(QUESTION)
    second = p.retrieve(QUESTION)

    assert first.stages["rerank"][0].status == "executed"
    assert first.stages["rerank"][0].usage == {"input_tokens": 9, "output_tokens": 4, "model": "made-up"}
    assert second.stages["rerank"][0].status == "cached"
    assert second.stages["rerank"][0].usage is None


# -- the node_finished event --------------------------------------------------------------


def _with_usage(self, inputs, config, ctx):
    set_usage(ctx, {"input_tokens": 3, "output_tokens": 1}, "m")
    return {"ok": True}


def test_node_finished_carries_usage_and_none_for_a_cached_or_model_free_step(tmp_path):
    reg = Registry()
    reg.register(_make("upload", Stage.SOURCE, {}, ArtifactType.RAW_FILE))
    reg.register(
        _make("fake_parse", Stage.PARSE, {"file": PortSpec(ArtifactType.RAW_FILE)},
              ArtifactType.PARSED_DOC, fn=_with_usage)
    )
    graph = Graph(
        nodes=[Node("s", Stage.SOURCE, "upload", {}), Node("p", Stage.PARSE, "fake_parse", {})],
        edges=[Edge("s", "p", "file")],
    )
    store = Store(tmp_path / "store")

    def finished(events):
        return {e["node_id"]: e for e in events if e["event"] == "node_finished"}

    first: list[dict] = []
    run(graph, reg, store, on_event=first.append)
    second: list[dict] = []
    run(graph, reg, store, on_event=second.append)

    assert finished(first)["p"]["usage"] == {"input_tokens": 3, "output_tokens": 1, "model": "m"}
    assert finished(first)["s"]["usage"] is None
    assert finished(second)["p"]["cache_hit"] is True
    assert finished(second)["p"]["usage"] is None


# -- the single-stage functions ------------------------------------------------------------


@pytest.fixture
def usage_steps():
    """A parse, a clean and a chunk step that each record usage; removed after the test."""
    from pandion.extend import ChunkSet, Element, ParsedDoc

    @register
    class UsageParse(Transform[EmptyCfg]):
        name = "test_usage_parse"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = EmptyCfg
        summary = "One block, and made-up usage."

        def apply(self, inputs, config, ctx):
            set_usage(ctx, {"input_tokens": 11, "output_tokens": 5}, "vlm")
            return ParsedDoc(elements=[Element(id="e1", type="paragraph", text="one", order=0)])

    @register
    class UsageClean(Transform[EmptyCfg]):
        name = "test_usage_clean"
        stage = Stage.CLEAN
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.PARSED_DOC
        config_model = EmptyCfg
        summary = "Keeps the document, and made-up usage."

        def apply(self, inputs, config, ctx):
            set_usage(ctx, {"input_tokens": 12, "output_tokens": 6}, "cleaner")
            return inputs["doc"]

    @register
    class UsageChunk(Transform[EmptyCfg]):
        name = "test_usage_chunk"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = EmptyCfg
        summary = "No pieces, and made-up usage."

        def apply(self, inputs, config, ctx):
            set_usage(ctx, {"input_tokens": 13, "output_tokens": None}, "chunker")
            return ChunkSet()

    yield
    from pandion.registry import registry

    registry._by_stage[Stage.PARSE].pop("test_usage_parse", None)
    registry._by_stage[Stage.CLEAN].pop("test_usage_clean", None)
    registry._by_stage[Stage.CHUNK].pop("test_usage_chunk", None)


def test_parse_clean_and_chunk_on_their_own_report_usage(tmp_path, usage_steps):
    import pandion

    f = tmp_path / "a.txt"
    f.write_text("one\n", encoding="utf-8")

    parsed = pandion.parse(f, use="test_usage_parse")
    cleaned = pandion.clean(parsed, steps=[{"use": "test_usage_clean"}])
    chunked = pandion.chunk(cleaned, use="test_usage_chunk")

    assert parsed.usage == {"input_tokens": 11, "output_tokens": 5, "model": "vlm"}
    assert cleaned.usage == {"input_tokens": 12, "output_tokens": 6, "model": "cleaner"}
    assert chunked.usage == {"input_tokens": 13, "output_tokens": None, "model": "chunker"}


def test_a_refusal_still_records_usage(monkeypatch):
    import pandion

    monkeypatch.setattr(
        llm, "complete",
        lambda model, **kw: Completion(text="I can't help.", usage={"input_tokens": 8, "output_tokens": 4}, stop_reason="refusal"),
    )
    result = pandion.rewrite(QUESTION, use="llm_rewrite", model="gpt-6-astra", credentials=CREDS)
    assert result.output.text == QUESTION
    assert result.usage == {"input_tokens": 8, "output_tokens": 4, "model": "gpt-6-astra"}
