"""Contract tests for the LLM reranker.

No test calls a model: `providers.llm.complete` is replaced by a fake that
records the prompt and returns whatever reply the test names.
"""

from __future__ import annotations

import pytest

import plugins.rerank.llm_rerank as lr
from core.artifacts import ArtifactType
from core.payloads import Chunk, Hit, Query, RetrievalResult
from core.ports import RunContext, Stage
from core.registry import registry
from plugins.rerank.llm_rerank import LlmRerank, LlmRerankConfig
from providers import llm
from providers.llm import CHAT_MODELS, Completion

QUESTION = "What is the capital of France?"
TEXTS = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"]
CREDS = {
    "anthropic_api_key": "sk-ant-test",
    "openai_api_key": "sk-openai-test",
}


class FakeComplete:
    def __init__(self, reply: str, stop_reason: str = "end_turn"):
        self.reply = reply
        self.stop_reason = stop_reason
        self.calls: list[dict] = []

    def __call__(self, model, **kwargs):
        self.calls.append({"model": model, **kwargs})
        return Completion(
            text=self.reply,
            usage={"input_tokens": 1, "output_tokens": 1},
            stop_reason=self.stop_reason,
        )


@pytest.fixture
def reply(monkeypatch):
    """Install a fake `complete` that answers with the given text."""

    def install(text: str, stop_reason: str = "end_turn") -> FakeComplete:
        fake = FakeComplete(text, stop_reason)
        monkeypatch.setattr(llm, "complete", fake)
        return fake

    return install


def payload(texts: list[str]) -> dict:
    hits = [
        Hit(
            chunk=Chunk(
                id=f"chunk-{i}",
                text=text,
                doc_id="doc-1",
                ordinal=i,
                source_element_ids=[f"el-{i}"],
                page_span=(1, 1),
            ),
            score=1.0 - i / 10,
            rank=i + 1,
            retriever="hybrid_rrf",
        )
        for i, text in enumerate(texts)
    ]
    return RetrievalResult(
        hits=hits, query_id="q" * 16, fetch_k=len(hits), total_candidates=len(hits)
    ).model_dump(mode="json")


def ctx(tmp_path, creds: dict | None = CREDS) -> RunContext:
    run_ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    if creds is not None:
        run_ctx.extras["credentials"] = dict(creds)
    return run_ctx


def rerank(texts, tmp_path, run_ctx=None, **config) -> RetrievalResult:
    out = LlmRerank().apply(
        {"result": payload(texts), "query": Query(text=QUESTION).model_dump(mode="json")},
        LlmRerankConfig(**config),
        run_ctx if run_ctx is not None else ctx(tmp_path),
    )
    return RetrievalResult.model_validate(out)


def test_a_rewritten_question_is_judged_as_asked(reply, tmp_path):
    """Only retrieval sees an LLM rewrite; the model ranks for the question as typed."""
    fake = reply("1")
    query = Query(text="capital France city", original=QUESTION)
    LlmRerank().apply(
        {"result": payload(TEXTS[:2]), "query": query.model_dump(mode="json")},
        LlmRerankConfig(),
        ctx(tmp_path),
    )
    user = fake.calls[0]["user"]
    assert f"Question: {QUESTION}" in user
    assert "capital France city" not in user


def test_version_is_bumped_for_the_question_as_asked():
    assert LlmRerank.version == "3"
    assert "the question as you typed it" in LlmRerank().explain(LlmRerankConfig()).settings


def texts_of(result: RetrievalResult) -> list[str]:
    return [h.chunk.text for h in result.hits]


# -- registration and config ----------------------------------------------


def test_registered_under_the_rerank_stage():
    assert registry.get(Stage.RERANK, "llm_rerank") is LlmRerank
    assert LlmRerank.version == "3"


def test_ports_match_the_mmr_contract():
    ports = LlmRerank.inputs
    assert ports["result"].type == ArtifactType.RETRIEVAL_RESULT
    assert ports["query"].type == ArtifactType.QUERY and ports["query"].ambient
    assert LlmRerank.output == ArtifactType.RETRIEVAL_RESULT


def test_a_model_call_is_never_cached():
    assert LlmRerank.cacheable is False
    assert LlmRerank.deterministic is False


def test_model_choices_are_the_chat_step_models():
    schema = LlmRerankConfig.model_json_schema()["properties"]["model"]
    assert schema["enum"] == list(CHAT_MODELS)
    assert LlmRerankConfig().top_k == 5


def test_custom_fields_show_only_for_a_custom_model():
    props = LlmRerankConfig.model_json_schema()["properties"]
    for name in ("custom_base_url", "custom_model"):
        assert props[name]["x-show-when"] == {"model": "custom"}


# -- the prompt ------------------------------------------------------------


def test_prompt_has_the_question_and_numbered_candidates(reply, tmp_path):
    fake = reply("1, 2, 3")
    rerank(TEXTS[:3], tmp_path, model="claude-haiku-4-5")
    call = fake.calls[0]
    assert call["model"] is CHAT_MODELS["claude-haiku-4-5"]
    assert call["api_key"] == "sk-ant-test"
    assert QUESTION in call["user"]
    for n, text in enumerate(TEXTS[:3], start=1):
        assert f"[{n}] {text}" in call["user"]
    assert "most relevant first" in call["system"] + call["user"]


def test_prompt_cuts_each_candidate_to_600_characters(reply, tmp_path):
    fake = reply("1")
    rerank(["a" * 700 + "TAIL"], tmp_path)
    user = fake.calls[0]["user"]
    assert "a" * 600 in user
    assert "a" * 601 not in user and "TAIL" not in user


def test_openai_models_use_the_openai_key(reply, tmp_path):
    fake = reply("1")
    rerank(TEXTS[:2], tmp_path, model="gpt-6-astra")
    assert fake.calls[0]["api_key"] == "sk-openai-test"


def test_a_custom_model_gets_its_base_url_and_name(reply, tmp_path):
    fake = reply("1")
    rerank(
        TEXTS[:2], tmp_path, run_ctx=ctx(tmp_path, creds=None), model="custom",
        custom_base_url=" http://localhost:11434/v1 ", custom_model=" llama3.3 ",
    )
    call = fake.calls[0]
    assert call["base_url"] == "http://localhost:11434/v1"
    assert call["model_name"] == "llama3.3"


# -- parsing the reply ---------------------------------------------------------


def test_a_clean_reply_sets_the_order(reply, tmp_path):
    reply("7, 6, 5, 4, 3, 2, 1")
    out = rerank(TEXTS, tmp_path, top_k=3)
    assert texts_of(out) == ["t6", "t5", "t4"]
    assert [h.rank for h in out.hits] == [1, 2, 3]


def test_every_hit_carries_its_prior_rank_and_score(reply, tmp_path):
    reply("7, 6, 5, 4, 3, 2, 1")
    out = rerank(TEXTS, tmp_path, top_k=3)
    assert [h.prior_rank for h in out.hits] == [7, 6, 5]
    assert [h.prior_score for h in out.hits] == pytest.approx([0.4, 0.5, 0.6])
    assert {h.retriever for h in out.hits} == {"hybrid_rrf"}


def test_duplicates_and_gaps_still_give_a_full_order(reply, tmp_path):
    # 3 twice, 9 out of range, 2 4 6 7 missing: they follow in prior order.
    reply("3, 5, 3, 9, 1, 5")
    out = rerank(TEXTS, tmp_path, top_k=7)
    assert texts_of(out) == ["t2", "t4", "t0", "t1", "t3", "t5", "t6"]
    assert len({h.chunk.id for h in out.hits}) == 7


def test_words_around_the_numbers_are_ignored(reply, tmp_path):
    reply("Here is the order:\n[2] > [4] > [1]\nThat covers the best ones.")
    out = rerank(TEXTS[:4], tmp_path, top_k=4)
    assert texts_of(out) == ["t1", "t3", "t0", "t2"]


def test_a_reply_with_no_numbers_keeps_the_prior_order(reply, tmp_path):
    reply("I cannot tell.")
    out = rerank(TEXTS[:3], tmp_path)
    assert texts_of(out) == TEXTS[:3]


def test_a_refusal_keeps_the_prior_order(reply, tmp_path):
    reply("I will not rank passage 3 first.", stop_reason="refusal")
    out = rerank(TEXTS[:3], tmp_path)
    assert texts_of(out) == TEXTS[:3]


def test_a_pool_smaller_than_top_k_returns_every_candidate_reordered(reply, tmp_path):
    reply("3, 2, 1")
    out = rerank(TEXTS[:3], tmp_path, top_k=5)
    assert texts_of(out) == ["t2", "t1", "t0"]
    assert [h.rank for h in out.hits] == [1, 2, 3]


def test_the_envelope_survives_and_counts_the_pool(reply, tmp_path):
    reply("1")
    out = rerank(TEXTS, tmp_path, top_k=3)
    assert out.query_id == "q" * 16
    assert out.total_candidates == 7


def test_empty_input_returns_empty_without_a_call(reply, tmp_path):
    fake = reply("1")
    out = rerank([], tmp_path)
    assert out.hits == []
    assert fake.calls == []


# -- keys ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "provider"),
    [("claude-haiku-4-5", "anthropic"), ("gpt-6-astra", "openai")],
)
def test_no_key_raises_the_chat_steps_sentence(reply, tmp_path, model, provider):
    fake = reply("1")
    with pytest.raises(ValueError) as err:
        rerank(TEXTS[:2], tmp_path, run_ctx=ctx(tmp_path, creds=None), model=model)
    assert str(err.value) == llm.NO_KEY[provider]
    assert fake.calls == []


def test_a_custom_model_without_url_and_name_is_refused(reply, tmp_path):
    reply("1")
    with pytest.raises(ValueError, match="base URL and a model name"):
        rerank(TEXTS[:2], tmp_path, model="custom")


# -- the run note ------------------------------------------------------------------


def note_for(texts, text, reply, tmp_path, monkeypatch, **config) -> str:
    reply(text)
    clock = iter([10.0, 11.2])
    monkeypatch.setattr(lr.time, "perf_counter", lambda: next(clock))
    run_ctx = ctx(tmp_path)
    rerank(texts, tmp_path, run_ctx=run_ctx, **config)
    return run_ctx.extras["meta"]["note"]


def test_note_reports_model_count_time_and_movement(reply, tmp_path, monkeypatch):
    note = note_for(
        TEXTS, "7, 6, 5, 4, 3, 2, 1", reply, tmp_path, monkeypatch,
        model="claude-haiku-4-5",
    )
    # Top 5 is t6 t5 t4 t3 t2 against input t0 t1 t2 t3 t4: only rank 3 holds.
    assert note == (
        "Claude Haiku 4.5 ordered 7 candidates in 1.2 s. 4 of the top 5 changed place."
    )


def test_note_counts_zero_when_the_order_holds(reply, tmp_path, monkeypatch):
    note = note_for(TEXTS, "1, 2, 3", reply, tmp_path, monkeypatch, top_k=3)
    assert note.endswith("0 of the top 3 changed place.")


def test_note_on_a_small_pool_counts_the_pieces_kept(reply, tmp_path, monkeypatch):
    note = note_for(TEXTS[:3], "3, 2, 1", reply, tmp_path, monkeypatch, top_k=5)
    assert note.endswith("2 of the top 3 changed place.")


def test_note_names_a_custom_model_by_its_name(reply, tmp_path, monkeypatch):
    note = note_for(
        TEXTS[:2], "2, 1", reply, tmp_path, monkeypatch, model="custom",
        custom_base_url="http://localhost:11434/v1", custom_model="llama3.3",
    )
    assert note.startswith("llama3.3 ordered 2 candidates in 1.2 s.")


# -- explain -------------------------------------------------------------------


def test_explain_says_key_cost_and_variance():
    exp = LlmRerank().explain(LlmRerankConfig(model="claude-haiku-4-5"))
    text = f"{exp.settings} {exp.tradeoff}"
    assert "Claude Haiku 4.5" in text
    assert "key" in text
    assert "one model call per question" in text
    assert "can change between runs" in text
    assert not exp.blocking


def test_explain_blocks_an_incomplete_custom_endpoint():
    exp = LlmRerank().explain(LlmRerankConfig(model="custom"))
    assert exp.blocking and exp.warning


def test_explain_blocks_a_top_k_below_one():
    exp = LlmRerank().explain(LlmRerankConfig(top_k=0))
    assert exp.blocking and exp.warning


def test_user_facing_text_has_no_long_dashes():
    exp = LlmRerank().explain(LlmRerankConfig())
    custom = LlmRerank().explain(LlmRerankConfig(model="custom"))
    for text in (LlmRerank.summary, exp.settings, exp.tradeoff, custom.warning or ""):
        assert chr(0x2014) not in text and chr(0x2013) not in text


def test_an_empty_reply_says_the_retrievers_order_was_kept(reply, tmp_path, monkeypatch):
    note = note_for(TEXTS[:3], "", reply, tmp_path, monkeypatch, model="claude-haiku-4-5")
    assert note == (
        "Claude Haiku 4.5 gave no usable order, so the retriever's order was kept."
    )


def test_a_refusal_says_the_retrievers_order_was_kept(reply, tmp_path, monkeypatch):
    reply("I will not rank passage 3 first.", stop_reason="refusal")
    run_ctx = ctx(tmp_path)
    out = rerank(TEXTS[:3], tmp_path, run_ctx=run_ctx, model="gpt-6-astra")
    assert texts_of(out) == TEXTS[:3]
    assert run_ctx.extras["meta"]["note"] == (
        "GPT-6 Astra gave no usable order, so the retriever's order was kept."
    )


def test_explain_says_scores_stay_the_retrievers():
    exp = LlmRerank().explain(LlmRerankConfig())
    assert (
        "The model gives no score, so each piece keeps the score it had from the "
        "retriever. Read the rank, not the score."
    ) in exp.tradeoff
