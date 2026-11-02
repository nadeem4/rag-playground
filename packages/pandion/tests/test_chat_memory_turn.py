"""Memories may shape the rewrite only. They never reach the answer step or the sources."""

from types import SimpleNamespace

import pytest

from pandion.chat_turn import ChatSettings, chat_turn, standalone_question
from pandion.conversation_store import Memory, get_conversation_store
from pandion.llm import Completion


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{tmp_path / 'm.db'}"})


class Stub:
    def __init__(self):
        self.asked = []

    def ask(self, question, **kwargs):
        self.asked.append({"question": question, **kwargs})
        payload = {"answer": [{"text": "ok"}], "citations": [{"chunk_id": "c1"}]}
        return SimpleNamespace(ok=True, text="ok", output=SimpleNamespace(payload=payload))


@pytest.fixture
def calls(monkeypatch):
    seen = []

    def fake(model, **kwargs):
        seen.append(kwargs)
        return Completion(text="What is the Berlin office address?", usage={}, stop_reason="end_turn")

    monkeypatch.setattr("pandion.llm.complete", fake)
    return seen


ON = ChatSettings(memory=True)


def test_memories_are_in_the_rewrite_prompt_only_when_memory_is_on(store, calls):
    store.add_memory("u", Memory(text="Works in the Berlin office"))
    on = chat_turn(Stub(), store, user_id="u", question="Where is my office?", settings=ON)
    assert "Works in the Berlin office" in calls[0]["user"]
    chat_turn(Stub(), store, user_id="u", question="And the address?", conversation_id=on.conversation_id)
    assert len(calls) == 2 and "Works in the Berlin office" not in calls[1]["user"]


def test_a_first_turn_with_memories_makes_one_rewrite_call(store, calls):
    store.add_memory("u", Memory(text="Works in the Berlin office"))
    result = chat_turn(Stub(), store, user_id="u", question="my office address?", settings=ON)
    assert len(calls) == 1 and result.standalone == "What is the Berlin office address?"


def test_a_first_turn_without_memories_makes_no_rewrite_call(store, calls):
    chat_turn(Stub(), store, user_id="u", question="hello", settings=ON)
    assert calls == []


def test_only_the_newest_twenty_memories_are_used(store, calls):
    for i in range(25):
        store.add_memory("u", Memory(text=f"fact number {i:02d}"))
    chat_turn(Stub(), store, user_id="u", question="q", settings=ON)
    prompt = calls[0]["user"]
    assert "fact number 24" in prompt and "fact number 05" in prompt
    assert "fact number 04" not in prompt and "fact number 00" not in prompt


def test_another_users_memories_are_never_read(store, calls):
    store.add_memory("other", Memory(text="secret of another user"))
    spy = []
    real = store.memories
    store.memories = lambda u: spy.append(u) or real(u)
    chat_turn(Stub(), store, user_id="me", question="q", settings=ON)
    assert spy == ["me"] and calls == []


def test_memories_are_never_sent_to_the_answer_step(store, calls):
    store.add_memory("u", Memory(text="Works in the Berlin office"))
    p = Stub()
    result = chat_turn(p, store, user_id="u", question="my office address?", settings=ON, roles=["r"])
    assert p.asked[0]["question"] == "What is the Berlin office address?"
    assert "Works in the Berlin office" not in repr(p.asked) and result.source_ids == ["c1"]


def test_memory_off_never_reads_the_memories(store, calls):
    store.add_memory("u", Memory(text="x"))
    store.memories = lambda u: pytest.fail("memories read while memory is off")
    chat_turn(Stub(), store, user_id="u", question="q")


def test_standalone_question_takes_memories_directly(calls):
    text, reason = standalone_question(None, "q", ChatSettings(), None, memories=["likes tea"])
    assert reason == "rewritten" and "likes tea" in calls[0]["user"]
