"""Speed and cost on every report: `cost()`, the price table, failed steps and the served model id.

`cost()` sums what the steps that ran in this run took and used, prices the
token counts with `pandion.llm.PRICES` (or the prices passed in), and counts
the cached steps on their own, so a run that reused the cache never looks
fast and cheap without saying so.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from pandion import llm
from pandion.artifacts import ArtifactType
from pandion.cost import cost
from pandion.evaluation import Comparison, Comparisons, EvaluationReport, QuestionResult
from pandion.executor import run
from pandion.extend import PortSpec, Stage, Transform, register, set_usage
from pandion.graph import Edge, Graph, Node
from pandion.llm import AS_OF, CHAT_MODELS, PRICES, Completion, complete
from pandion.pipeline import Answer, DocumentReport, IndexReport, Retrieval, SyncReport
from pandion.plugins.answer import chat as chat_plugin
from pandion.registry import Registry
from pandion.results import StageResult
from pandion.storage import Store
from fakes import EmptyCfg, _make
from test_usage import CREDS, QUESTION, built

TABLE = {"model-a": (2.0, 10.0), "model-b": (1.0, 5.0)}


def step(status="executed", ms=0.0, usage=None, stage="rerank") -> StageResult:
    return StageResult(stage=stage, transform="t", output=None, status=status, duration_ms=ms, usage=usage)


def use(model, i, o):
    return {"input_tokens": i, "output_tokens": o, "model": model}


def retrieval(*rerank: StageResult, rewrite=None, search=None, index=None) -> Retrieval:
    return Retrieval(
        stages={
            "rewrite": rewrite or step("cached", stage="rewrite"),
            "search": search or step("cached", stage="search"),
            "rerank": list(rerank),
        },
        index=index or step("cached", stage="index"),
    )


# -- the price table ------------------------------------------------------------------


def test_every_native_model_has_a_price_and_openrouter_and_custom_have_none():
    native = {m.id for m in CHAT_MODELS.values() if m.provider in ("anthropic", "openai")}
    assert set(PRICES) == native
    assert "openrouter" not in PRICES and "custom" not in PRICES
    assert all(i > 0 and o > 0 for i, o in PRICES.values())
    assert len(AS_OF) == 10 and AS_OF[4] == "-"


# -- cost() ------------------------------------------------------------------------------


def test_a_fixed_price_table_gives_exact_dollars():
    r = retrieval(
        step(ms=1500, usage=use("model-a", 1_000, 200)),
        step(ms=340, usage=use("model-b", 2_000, 100)),
        search=step(ms=10, stage="search"),
    )
    cost = r.cost(prices=TABLE)
    assert cost == {
        "seconds": pytest.approx(1.85),
        "input_tokens": 3_000,
        "output_tokens": 300,
        # 1000 * 2 + 200 * 10 + 2000 * 1 + 100 * 5, per million
        "dollars": pytest.approx(0.0065),
        "unpriced_models": [],
        "uncounted_models": [],
        "steps_run": 3,
        "steps_cached": 2,
        "prices_as_of": "custom",
    }


def test_without_prices_the_package_table_and_its_date_are_used():
    r = retrieval(step(usage=use("claude-haiku-4-5", 1_000_000, 0)))
    cost = r.cost()
    assert cost["dollars"] == pytest.approx(PRICES["claude-haiku-4-5"][0])
    assert cost["prices_as_of"] == AS_OF


def test_an_unknown_model_is_unpriced_and_nothing_priced_means_no_dollars():
    r = retrieval(
        step(usage=use("openrouter/auto", 50, 5)),
        step(usage=use("llama3", None, None)),
    )
    cost = r.cost(prices=TABLE)
    assert cost["dollars"] is None
    assert cost["unpriced_models"] == ["llama3", "openrouter/auto"]
    assert cost["input_tokens"] == 50 and cost["output_tokens"] == 5


def test_a_priced_and_an_unpriced_step_price_only_the_priced_one():
    r = retrieval(step(usage=use("model-a", 1_000_000, 0)), step(usage=use("openrouter/auto", 9, 9)))
    cost = r.cost(prices=TABLE)
    assert cost["dollars"] == pytest.approx(2.0)
    assert cost["unpriced_models"] == ["openrouter/auto"]


def test_no_usage_anywhere_means_no_token_counts():
    cost = retrieval(step(ms=20)).cost()
    assert cost["input_tokens"] is None and cost["output_tokens"] is None and cost["dollars"] is None
    assert cost["unpriced_models"] == []


def test_cached_steps_are_counted_but_add_no_time_tokens_or_dollars():
    ran = retrieval(step(ms=1000, usage=use("model-a", 100, 10)))
    with_cache = retrieval(
        step(ms=1000, usage=use("model-a", 100, 10)),
        # A cached step's stored duration and usage never count.
        step("cached", ms=5000, usage=use("model-a", 999, 999)),
    )
    a, b = ran.cost(prices=TABLE), with_cache.cost(prices=TABLE)
    assert b["steps_cached"] == a["steps_cached"] + 1
    assert (b["seconds"], b["input_tokens"], b["output_tokens"], b["dollars"]) == (
        a["seconds"], a["input_tokens"], a["output_tokens"], a["dollars"],
    )


def test_skipped_and_pruned_steps_count_nowhere():
    cost = retrieval(step("failed", ms=200), step("skipped", ms=0)).cost()
    assert cost["steps_run"] == 1 and cost["steps_cached"] == 3
    assert cost["seconds"] == pytest.approx(0.2)


def test_answer_index_eval_and_compare_reports_all_have_cost():
    r = retrieval(step(ms=1000, usage=use("model-a", 100, 10)))
    answer = Answer(retrieval=r, answer=step(ms=500, usage=use("model-b", 200, 20), stage="answer"))
    assert answer.cost(prices=TABLE)["input_tokens"] == 300

    index = IndexReport(
        documents={"a.pdf": DocumentReport(stages={"parse": step(ms=700, stage="parse"), "chunk": step("cached", stage="chunk")})},
        index=step(ms=300, stage="index"),
    )
    assert index.cost()["seconds"] == pytest.approx(1.0)
    assert index.cost()["steps_cached"] == 1
    sync = SyncReport(documents=index.documents, index=index.index)
    assert sync.cost() == index.cost()

    question = QuestionResult(
        id="q", question="?", golds=[], tags=[], found=True, rank=1, lost_at=None,
        trace=None, score={}, retrieval=r,
    )
    report = EvaluationReport(top_k=5, questions=[question, question])
    assert report.cost(prices=TABLE)["input_tokens"] == 200
    assert report.cost(prices=TABLE)["steps_run"] == 2

    comparison = Comparison(stage="chunk", variant={"use": "x"}, pipeline=None, index=index, report=report)
    assert comparison.cost(prices=TABLE)["steps_run"] == 4
    assert comparison.cost(prices=TABLE)["input_tokens"] == 200
    both = Comparisons([comparison, comparison])
    assert both.cost(prices=TABLE)["steps_run"] == 8


# -- a failed step still reports its usage -------------------------------------------------


def _spends_then_fails(self, inputs, config, ctx):
    set_usage(ctx, {"input_tokens": 70, "output_tokens": 7}, "model-a")
    raise RuntimeError("the reply could not be read")


def test_node_failed_carries_the_usage_the_step_recorded(tmp_path):
    reg = Registry()
    reg.register(_make("upload", Stage.SOURCE, {}, ArtifactType.RAW_FILE))
    reg.register(
        _make("fake_parse", Stage.PARSE, {"file": PortSpec(ArtifactType.RAW_FILE)},
              ArtifactType.PARSED_DOC, fn=_spends_then_fails)
    )
    graph = Graph(
        nodes=[Node("s", Stage.SOURCE, "upload", {}), Node("p", Stage.PARSE, "fake_parse", {})],
        edges=[Edge("s", "p", "file")],
    )
    events: list[dict] = []
    result = run(graph, reg, Store(tmp_path / "store"), on_event=events.append)

    [failed] = [e for e in events if e["event"] == "node_failed"]
    assert failed["usage"] == {"input_tokens": 70, "output_tokens": 7, "model": "model-a"}
    assert result.nodes["p"].usage == failed["usage"]


@pytest.fixture
def failing_rerank():
    """A rerank step that records usage and then fails; removed after the test."""

    @register
    class SpendsThenFails(Transform[EmptyCfg]):
        name = "test_cost_failing_rerank"
        stage = Stage.RERANK
        inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = EmptyCfg
        summary = "Records usage, then fails."

        apply = _spends_then_fails

    yield
    from pandion.registry import registry

    registry._by_stage[Stage.RERANK].pop("test_cost_failing_rerank", None)


def test_a_failed_step_keeps_its_usage_on_its_result_and_in_cost(tmp_path, failing_rerank):
    p = built(tmp_path, "retrieve:\n  search: {use: bm25}\n  rerank: {use: test_cost_failing_rerank}\n")

    r = p.retrieve(QUESTION)

    [rerank] = r.stages["rerank"]
    assert rerank.status == "failed"
    assert rerank.usage == {"input_tokens": 70, "output_tokens": 7, "model": "model-a"}
    cost = r.cost(prices=TABLE)
    assert cost["input_tokens"] == 70 and cost["output_tokens"] == 7
    assert cost["dollars"] == pytest.approx((70 * 2 + 7 * 10) / 1e6)


# -- the served model id ----------------------------------------------------------------------


def test_the_openai_compatible_path_reads_the_served_model(monkeypatch):
    reply = SimpleNamespace(
        model="openai/gpt-4o-mini",
        choices=[SimpleNamespace(message=SimpleNamespace(content="ok", refusal=None), finish_reason="stop")],
        usage=SimpleNamespace(prompt_tokens=3, completion_tokens=1),
    )
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: reply)))
    monkeypatch.setattr(llm, "make_openai_client", lambda *a, **kw: client)
    out = complete(CHAT_MODELS["openrouter"], system="s", user="u", api_key="k", model_name="openrouter/auto")
    assert out.model == "openai/gpt-4o-mini"


def test_the_anthropic_path_reads_the_served_model(monkeypatch):
    response = SimpleNamespace(
        model="claude-haiku-4-5-20251001",
        content=[SimpleNamespace(type="text", text="ok")],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=3, output_tokens=1),
    )
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: response)))
    monkeypatch.setattr(llm, "make_anthropic_client", lambda key: client)
    out = complete(CHAT_MODELS["claude-haiku-4-5"], system="s", user="u", api_key="k")
    assert out.model == "claude-haiku-4-5-20251001"


def test_a_reply_without_a_model_gives_none(monkeypatch):
    reply = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="ok", refusal=None), finish_reason="stop")],
        usage=None,
    )
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: reply)))
    monkeypatch.setattr(llm, "make_openai_client", lambda *a, **kw: client)
    out = complete(CHAT_MODELS["custom"], system="s", user="u", api_key=None,
                   base_url="http://localhost:11434/v1", model_name="llama3")
    assert out.model is None


def test_each_model_step_records_the_model_the_server_used(tmp_path, monkeypatch):
    def fake(model, **kwargs):
        if kwargs["system"] == chat_plugin.SENTENCE_PROMPT:
            text = "Paris is the capital of France [1.1]."
        elif "search words" in kwargs["system"]:
            text = "capital France Paris"
        else:
            text = "2, 1"
        return Completion(text=text, usage={"input_tokens": 4, "output_tokens": 2},
                          stop_reason="stop", model="served/model")

    monkeypatch.setattr(llm, "complete", fake)
    p = built(
        tmp_path,
        "retrieve:\n"
        "  rewrite: {use: llm_rewrite, style: keywords, model: openrouter, openrouter_model: openrouter/auto}\n"
        "  search: {use: bm25, top_k: 4}\n"
        "  rerank: {use: llm_rerank, top_k: 2, model: openrouter, openrouter_model: openrouter/auto}\n"
        "answer: {use: chat, model: openrouter, openrouter_model: openrouter/auto}\n",
    )

    answer = p.ask(QUESTION, credentials={**CREDS, "openrouter_api_key": "or-test"})

    assert answer.ok, answer.stages["answer"].error
    assert answer.stages["rewrite"].usage["model"] == "served/model"
    assert answer.stages["rerank"][0].usage["model"] == "served/model"
    assert answer.stages["answer"].usage["model"] == "served/model"
    assert answer.cost()["unpriced_models"] == ["served/model"]


def test_without_a_served_model_the_requested_id_is_recorded(tmp_path, monkeypatch):
    monkeypatch.setattr(
        llm, "complete",
        lambda model, **kw: Completion(text="capital France", usage={"input_tokens": 5, "output_tokens": 2}, stop_reason="stop"),
    )
    import pandion

    result = pandion.rewrite(QUESTION, use="llm_rewrite", model="gpt-6-astra", credentials=CREDS)
    assert result.usage["model"] == "gpt-6-astra"


# -- review fixes -------------------------------------------------------------------------------


def test_set_usage_records_the_requested_id_when_the_server_used_another(tmp_path):
    from test_usage import ctx

    run_ctx = ctx(tmp_path)
    set_usage(run_ctx, {"input_tokens": 1, "output_tokens": 1}, "claude-haiku-4-5-20251001",
              requested_model="claude-haiku-4-5")
    assert run_ctx.extras["meta"]["usage"]["requested_model"] == "claude-haiku-4-5"
    same = ctx(tmp_path)
    set_usage(same, {"input_tokens": 1, "output_tokens": 1}, "m", requested_model="m")
    assert "requested_model" not in same.extras["meta"]["usage"]


@pytest.mark.parametrize(
    ("served", "requested", "priced_as"),
    [
        ("claude-haiku-4-5-20251001", None, "claude-haiku-4-5"),
        ("gpt-5.6-sol-2026-08-06", None, "gpt-5.6-sol"),
        ("some-snapshot-name", "gpt-5.6-luna", "gpt-5.6-luna"),
    ],
)
def test_a_dated_or_renamed_served_id_is_priced_as_the_model_asked_for(served, requested, priced_as):
    usage = {**use(served, 1_000_000, 0), **({"requested_model": requested} if requested else {})}
    cost = retrieval(step(usage=usage)).cost()
    assert cost["unpriced_models"] == []
    assert cost["dollars"] == pytest.approx(PRICES[priced_as][0])


def test_the_model_steps_record_the_requested_id_beside_the_served_one(tmp_path, monkeypatch):
    monkeypatch.setattr(
        llm, "complete",
        lambda model, **kw: Completion(text="capital France", usage={"input_tokens": 5, "output_tokens": 2},
                                       stop_reason="stop", model="gpt-6-astra-2026-09-01"),
    )
    import pandion

    result = pandion.rewrite(QUESTION, use="llm_rewrite", model="gpt-6-astra", credentials=CREDS)
    assert result.usage["model"] == "gpt-6-astra-2026-09-01"
    assert result.usage["requested_model"] == "gpt-6-astra"


def test_a_priced_model_with_a_missing_count_is_uncounted_not_unpriced():
    r = retrieval(
        step(usage=use("model-a", 100, None)),
        step(usage={"input_tokens": 5, "output_tokens": 5, "model": None}),
    )
    cost = r.cost(prices=TABLE)
    assert cost["uncounted_models"] == ["model-a"]
    assert cost["unpriced_models"] == []
    assert cost["dollars"] is None


def test_a_cold_retrieval_counts_the_indexing_it_did_on_the_way(tmp_path):
    p = built(tmp_path, "retrieve:\n  search: {use: bm25}\n")
    docs = tmp_path / "docs"
    cold = p.retrieve(QUESTION, documents=docs, force=True)
    cost = cold.cost()
    upstream = [s for s in cold.upstream if s.stage in ("parse", "chunk")]
    assert upstream and all(s.status == "executed" for s in upstream)
    assert cost["steps_run"] >= len(cold._steps()) + len(upstream)
    assert cost["seconds"] >= sum(s.duration_ms for s in upstream) / 1000
    warm = p.retrieve(QUESTION, documents=docs)
    assert warm.cost()["steps_cached"] >= len(upstream)
    assert warm.ok and "upstream" not in repr(warm)


def test_a_cached_read_of_a_step_that_ran_in_the_same_report_is_not_counted_again():
    ran = step(ms=200, stage="chunk")
    ran.artifact_id = "b" * 64
    read = step("cached", stage="chunk")
    read.artifact_id = "b" * 64
    result = cost([read, ran, read], prices=TABLE)
    assert result["steps_run"] == 1
    assert result["steps_cached"] == 0


def test_each_cached_step_counts_once_across_a_report():
    index = step("cached", stage="index")
    index.artifact_id = "a" * 64
    rerank = step(ms=100, usage=use("model-a", 10, 1))
    question = QuestionResult(
        id="q", question="?", golds=[], tags=[], found=True, rank=1, lost_at=None,
        trace=None, score={}, retrieval=retrieval(rerank, index=index),
    )
    cost = EvaluationReport(top_k=5, questions=[question, question, question]).cost(prices=TABLE)
    # rewrite and search have no artifact id, so they count each time; the index once.
    assert cost["steps_cached"] == 2 * 3 + 1
    assert cost["steps_run"] == 3
