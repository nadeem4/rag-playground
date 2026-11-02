"""The running summary: older turns are folded, the last N stay verbatim, nothing is folded twice."""

import pytest

from pandion.chat_turn import ChatSettings, fold_summary
from pandion.conversation_store import Turn, get_conversation_store
from pandion.llm import Completion


class Fake:
    def __init__(self, reply="They discussed a lease.", raises=None):
        self.reply, self.raises, self.calls = reply, raises, []

    def __call__(self, model, **kwargs):
        self.calls.append(kwargs)
        if self.raises:
            raise self.raises
        return Completion(text=self.reply, usage={}, stop_reason="end_turn")


@pytest.fixture
def fake(monkeypatch):
    f = Fake()
    monkeypatch.setattr("pandion.llm.complete", f)
    return f


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{tmp_path / 'c.db'}"})


SETTINGS = ChatSettings(last_turns=3)


def fill(store, n, user="u"):
    for i in range(n):
        store.append("c", user, Turn(question=f"question {i}", answer=f"answer {i}", source_ids=["SRC-ID-77"]))


def test_nothing_is_folded_while_the_chat_is_short(store, fake):
    fill(store, 3)
    assert fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS) is False
    assert fake.calls == []


def test_older_turns_are_folded_and_the_last_n_stay_verbatim(store, fake):
    fill(store, 5)
    assert fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS) is True
    conv = store.load("c", "u")
    assert (conv.summary, conv.summary_upto, len(conv.turns)) == ("They discussed a lease.", 2, 5)
    prompt = fake.calls[0]["user"]
    assert "question 0" in prompt and "question 1" in prompt and "question 2" not in prompt


def test_fold_summary_is_idempotent(store, fake):
    fill(store, 5)
    fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS)
    assert fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS) is False
    assert len(fake.calls) == 1


def test_the_next_fold_sends_the_old_summary_with_only_the_new_turns(store, fake):
    fill(store, 5)
    fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS)
    store.append("c", "u", Turn(question="question 5", answer="answer 5"))
    assert fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS) is True
    prompt = fake.calls[1]["user"]
    assert "They discussed a lease." in prompt and "question 2" in prompt
    assert "question 0" not in prompt and "question 3" not in prompt
    assert store.load("c", "u").summary_upto == 3


def test_a_failed_summary_call_changes_nothing(store, monkeypatch):
    monkeypatch.setattr("pandion.llm.complete", Fake(raises=RuntimeError("down")))
    fill(store, 5)
    with pytest.raises(RuntimeError):
        fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS)
    conv = store.load("c", "u")
    assert (conv.summary, conv.summary_upto) == ("", 0)


def test_the_summary_prompt_has_questions_and_answers_but_no_sources(store, fake):
    fill(store, 5)
    fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS)
    prompt = fake.calls[0]["user"]
    assert "answer 0" in prompt and "SRC-ID-77" not in prompt


def test_the_summary_is_capped(store, monkeypatch):
    long = "A sentence about the lease. " * 100
    monkeypatch.setattr("pandion.llm.complete", Fake(reply=long))
    fill(store, 5)
    fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS)
    summary = store.load("c", "u").summary
    assert len(summary) <= 1500 and summary.endswith(".")


def test_fold_summary_for_another_users_conversation_does_nothing(store, fake):
    fill(store, 5)
    assert fold_summary(store, conversation_id="c", user_id="intruder", settings=SETTINGS) is False
    assert fake.calls == []
    assert store.load("c", "u").summary_upto == 0


def test_an_empty_summary_reply_is_an_error_and_changes_nothing(store, monkeypatch):
    monkeypatch.setattr("pandion.llm.complete", Fake(reply=""))
    fill(store, 5)
    with pytest.raises(ValueError):
        fold_summary(store, conversation_id="c", user_id="u", settings=SETTINGS)
    assert store.load("c", "u").summary_upto == 0
