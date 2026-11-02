"""Memory across conversations: off by default, the user's own questions only, bad replies add nothing."""

import json

import pytest

from pandion.chat_turn import ChatSettings, remember
from pandion.conversation_store import Memory, get_conversation_store
from pandion.llm import Completion


class Fake:
    def __init__(self, reply='["Works in the Berlin office"]', raises=None):
        self.reply, self.raises, self.calls = reply, raises, []

    def __call__(self, model, **kwargs):
        self.calls.append({"model": model, **kwargs})
        if self.raises:
            raise self.raises
        return Completion(text=self.reply, usage={}, stop_reason="end_turn")


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{tmp_path / 'm.db'}"})


def use(monkeypatch, **kw):
    f = Fake(**kw)
    monkeypatch.setattr("pandion.llm.complete", f)
    return f


ON = ChatSettings(memory=True)


def test_memory_off_makes_no_memory_calls(store, monkeypatch):
    f = use(monkeypatch)
    spy = []
    real = store.memories
    store.memories = lambda u: spy.append(u) or real(u)
    assert remember(store, user_id="u", question="I work in Berlin") == []
    assert remember(store, user_id="u", question="I work in Berlin", settings=ChatSettings()) == []
    assert f.calls == [] and spy == [] and store.memories("u") == []


def test_facts_are_stored_and_returned(store, monkeypatch):
    use(monkeypatch)
    added = remember(store, user_id="u", question="I work in the Berlin office", settings=ON)
    assert [m.text for m in added] == ["Works in the Berlin office"]
    assert [m.text for m in store.memories("u")] == ["Works in the Berlin office"]


def test_only_the_users_question_is_sent(store, monkeypatch):
    f = use(monkeypatch)
    remember(store, user_id="u", question="I work in Berlin", settings=ON)
    assert "I work in Berlin" in f.calls[0]["user"]


def test_at_most_three_facts_each_cut_to_200_characters(store, monkeypatch):
    use(monkeypatch, reply=json.dumps(["a" * 300, "b", "c", "d"]))
    added = remember(store, user_id="u", question="q", settings=ON)
    assert len(added) == 3 and len(added[0].text) == 200


def test_empty_and_duplicate_facts_are_dropped_even_against_stored_ones(store, monkeypatch):
    store.add_memory("u", Memory(text="Works in Berlin"))
    use(monkeypatch, reply=json.dumps(["  works   IN berlin ", "", "  ", "Likes tea", "likes TEA"]))
    added = remember(store, user_id="u", question="q", settings=ON)
    assert [m.text for m in added] == ["Likes tea"]
    assert len(store.memories("u")) == 2


@pytest.mark.parametrize("reply", ["not json", '{"a": 1}', "[1, 2]", ""])
def test_an_unreadable_reply_adds_nothing(store, monkeypatch, reply):
    use(monkeypatch, reply=reply)
    assert remember(store, user_id="u", question="q", settings=ON) == []
    assert store.memories("u") == []


def test_a_failed_call_adds_nothing_and_does_not_raise(store, monkeypatch):
    use(monkeypatch, raises=RuntimeError("down"))
    assert remember(store, user_id="u", question="q", settings=ON) == []


def test_memories_belong_to_the_user(store, monkeypatch):
    use(monkeypatch)
    remember(store, user_id="a", question="q", settings=ON)
    assert store.memories("b") == []
