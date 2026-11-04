"""chat_turn keeps one trace record per answered turn, when the store can."""

import pytest

from pandion.chat_turn import chat_turn
from pandion.conversation_store import get_conversation_store
from pandion.results import StageResult
from trace_helpers import StubPipeline


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{(tmp_path / 'c.db').as_posix()}"})


def test_a_turn_saves_one_trace_with_its_id(store):
    result = chat_turn(StubPipeline(), store, user_id="u", question="Notice?", trace_id="abc")
    records = store.traces()
    assert [r.trace_id for r in records] == ["abc"]
    r = records[0]
    assert (r.user_id, r.conversation_id, r.question, r.answer, r.label, r.source_ids) == (
        "u", result.conversation_id, "Notice?", "The notice period is 30 days.", "cited", ["c1"])
    assert r.cost == 0.0021 and r.latency_ms >= 0 and r.created_at
    assert store.load(result.conversation_id, "u").turns[0].trace_id == "abc"


def test_a_turn_without_a_trace_id_makes_one(store):
    result = chat_turn(StubPipeline(), store, user_id="u", question="Notice?")
    turn = store.load(result.conversation_id, "u").turns[0]
    assert turn.trace_id and store.trace(turn.trace_id, "u") is not None


def test_the_label_is_the_worst_grounding_in_the_answer(store):
    chat_turn(StubPipeline(stats={"cited": 2, "weak": 1}), store, user_id="u", question="a", trace_id="w")
    chat_turn(StubPipeline(stats={"not_found": 1}), store, user_id="u", question="b", trace_id="n")
    assert (store.trace("w").label, store.trace("n").label) == ("weak", "not_found")


def test_a_failed_answer_saves_no_trace(store):
    chat_turn(StubPipeline(ok=False), store, user_id="u", question="q", trace_id="x")
    assert store.traces() == []


def test_a_store_without_traces_still_chats(store):
    class Plain:
        """Only the ten contract methods."""

        def __getattr__(self, name):
            if name in {"save_trace", "trace", "traces", "add_feedback", "save_scores"}:
                raise AttributeError(name)
            return getattr(store, name)

    result = chat_turn(StubPipeline(), Plain(), user_id="u", question="Notice?")
    assert result.text and store.load(result.conversation_id, "u") is not None
    assert store.traces() == []


def test_a_failing_trace_save_never_fails_the_turn(store, monkeypatch, caplog):
    monkeypatch.setattr(type(store), "save_trace", lambda self, record: 1 / 0)
    result = chat_turn(StubPipeline(), store, user_id="u", question="Notice?")
    assert result.text and "trace" in caplog.text.lower()


def test_trace_stages_list_every_stage_once(store):
    chat_turn(StubPipeline(), store, user_id="u", question="q", trace_id="s")
    stages = store.trace("s").stages
    assert [s["name"] for s in stages] == ["search", "answer"]
    assert stages[0]["ms"] == 12 and stages[0]["dollars"] is None
    assert stages[1]["dollars"] == pytest.approx(0.0015, abs=1e-6)


def test_a_failing_trace_save_does_not_log_the_question(store, monkeypatch, caplog):
    def boom(self, record):
        raise RuntimeError(f"[parameters: ({record.question!r}, {record.answer!r})]")

    monkeypatch.setattr(type(store), "save_trace", boom)
    chat_turn(StubPipeline(), store, user_id="u", question="my secret question", trace_id="x")
    assert "my secret question" not in caplog.text and "RuntimeError" in caplog.text


def test_the_result_carries_the_trace_id(store):
    assert chat_turn(StubPipeline(), store, user_id="u", question="q", trace_id="abc").trace_id == "abc"
    assert len(chat_turn(StubPipeline(), store, user_id="u", question="q").trace_id) == 32


def test_trace_saves_when_the_answer_has_rerank_steps_in_a_list(store):
    # The real shape: Answer.stages["rerank"] is a list of steps, the others are one step each.
    class Reranked(StubPipeline):
        def ask(self, question, **kwargs):
            answer = super().ask(question, **kwargs)
            answer.stages["rerank"] = [StageResult("rerank", "cross_encoder", None, duration_ms=7.0),
                                       StageResult("rerank", "mmr", None, duration_ms=3.0)]
            return answer

    chat_turn(Reranked(), store, user_id="u", question="q", trace_id="r")
    stages = store.trace("r").stages
    assert [(s["name"], s["ms"]) for s in stages] == [("search", 12), ("answer", 30), ("rerank.1", 7), ("rerank.2", 3)]
