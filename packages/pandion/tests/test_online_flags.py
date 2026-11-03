"""Online flags on a turn, and feedback on its trace."""

from types import SimpleNamespace

import pytest

from pandion.chat_turn import chat_turn
from pandion.conversation_store import get_conversation_store
from pandion.flags import TracesNotKept, flags_for, give_feedback
from pandion.trace_report import summarise_traces
from trace_helpers import StubPipeline


def answer(stats, hits=("h",), stop=None):
    payload = {"stats": stats, **({"stop_reason": stop} if stop else {})}
    return SimpleNamespace(output=SimpleNamespace(payload=payload), hits=list(hits))


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{(tmp_path / 'c.db').as_posix()}"})


@pytest.mark.parametrize("stats", [{"weak": 1}, {"none": 1}, {"cited": 2, "weak": 1}])
def test_weak_and_none_labels_are_low_grounding(stats):
    assert flags_for(answer(stats)) == ["low_grounding"]


def test_a_safety_refusal_is_declined():
    assert flags_for(answer({}, stop="refusal")) == ["declined"]
    assert flags_for(answer({"cited": 1}, stop="end_turn")) == []


def test_not_found_is_not_in_documents():
    assert flags_for(answer({"not_found": 1})) == ["not_in_documents"]


def test_no_hit_is_not_in_documents():
    assert flags_for(answer({"cited": 1}, hits=())) == ["not_in_documents"]
    assert flags_for(answer({"not_found": 1}, hits=())) == ["not_in_documents"]


def test_a_cited_answer_has_no_flags():
    assert flags_for(answer({"cited": 3})) == []
    assert flags_for(answer({"similarity": 1})) == []


def test_an_answer_without_hits_info_is_not_flagged_for_it():
    stub = SimpleNamespace(output=SimpleNamespace(payload={"stats": {"cited": 1}}))
    assert flags_for(stub) == []


def test_turn_result_and_trace_carry_the_flags(store):
    result = chat_turn(StubPipeline(stats={"weak": 1}), store, user_id="u", question="q", trace_id="f")
    assert result.flags == ["low_grounding"]
    assert store.trace("f").flags == ["low_grounding"]
    assert [r.trace_id for r in store.traces(flagged_only=True)] == ["f"]
    assert chat_turn(StubPipeline(), store, user_id="u", question="q").flags == []


def test_not_in_documents_reaches_the_stored_trace(store):
    chat_turn(StubPipeline(hits=[]), store, user_id="u", question="q", trace_id="e")
    assert store.trace("e").flags == ["not_in_documents"]


def test_a_search_answer_with_hits_has_no_flags(store):
    stub = StubPipeline(stats={})
    result = chat_turn(stub, store, user_id="u", question="q", trace_id="s")
    assert result.flags == [] and store.trace("s").flags == []


def test_a_failed_turn_has_no_flags(store):
    assert chat_turn(StubPipeline(ok=False), store, user_id="u", question="q").flags == []


def test_repeat_feedback_replaces_the_older(store):
    chat_turn(StubPipeline(), store, user_id="u", question="q", trace_id="t")
    give_feedback(store, "t", "u", "up")
    give_feedback(store, "t", "u", "down", comment="changed my mind")
    assert [f.value for f in store.trace("t").feedback] == ["down"]


def test_a_store_without_traces_raises_traces_not_kept():
    with pytest.raises(TracesNotKept):
        give_feedback(object(), "t", "u", "up")
    assert not issubclass(TracesNotKept, ValueError)


def test_feedback_up_down_only(store):
    chat_turn(StubPipeline(), store, user_id="u", question="q", trace_id="t")
    assert give_feedback(store, "t", "u", "up", category="tone") is True
    with pytest.raises(ValueError, match="up.*down"):
        give_feedback(store, "t", "u", "meh")
    fb = store.trace("t").feedback
    assert [(f.value, f.category) for f in fb] == [("up", "tone")]


def test_feedback_for_a_missing_or_foreign_trace_returns_false(store):
    chat_turn(StubPipeline(), store, user_id="u", question="q", trace_id="t")
    assert give_feedback(store, "nope", "u", "up") is False
    assert give_feedback(store, "t", "other", "down") is False
    assert store.trace("t").feedback == []


def test_feedback_shows_in_the_report_counts(store):
    chat_turn(StubPipeline(), store, user_id="u", question="q", trace_id="t")
    give_feedback(store, "t", "u", "down", comment="wrong date")
    assert summarise_traces(store.traces()).feedback == {"down": 1}


def test_comment_and_category_limits_are_refused(store):
    chat_turn(StubPipeline(), store, user_id="u", question="q", trace_id="t")
    with pytest.raises(ValueError, match="500"):
        give_feedback(store, "t", "u", "up", comment="x" * 501)
    with pytest.raises(ValueError, match="40"):
        give_feedback(store, "t", "u", "up", category="x" * 41)
    assert give_feedback(store, "t", "u", "up", comment="x" * 500, category="y" * 40) is True


def test_a_store_without_traces_refuses_feedback_in_one_sentence():
    with pytest.raises(TracesNotKept, match="does not keep traces"):
        give_feedback(object(), "t", "u", "up")


def test_the_refusal_does_not_echo_the_comment(store):
    with pytest.raises(ValueError) as err:
        give_feedback(store, "t", "u", "up", comment="secret " * 100)
    assert "secret" not in str(err.value)
