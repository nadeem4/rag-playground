"""One chat turn: load, rewrite, ask, store. The pipeline is a stub that records what it is asked."""

import json
from types import SimpleNamespace

import pytest

from pandion.chat_turn import ChatSettings, chat_turn
from pandion.conversation_store import ConversationNotFound, get_conversation_store
from pandion.llm import Completion
from pandion.pipeline import Pipeline
from pdfs import build_pdf


class StubPipeline:
    def __init__(self, text="The notice period is 30 days.", ok=True):
        self.asked, self.text, self.ok = [], text, ok

    def ask(self, question, **kwargs):
        self.asked.append({"question": question, **kwargs})
        payload = {"answer": [{"text": self.text}], "citations": [{"chunk_id": "c1"}, {"chunk_id": "c2"}, {"chunk_id": "c1"}]}
        return SimpleNamespace(ok=self.ok, text=self.text if self.ok else "", output=SimpleNamespace(payload=payload) if self.ok else None)


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{tmp_path / 'c.db'}"})


@pytest.fixture
def rewrites(monkeypatch):
    calls = []

    def fake(model, **kwargs):
        calls.append(kwargs)
        return Completion(text="What is the notice period in the lease?", usage={}, stop_reason="end_turn")

    monkeypatch.setattr("pandion.llm.complete", fake)
    return calls


def test_a_new_conversation_is_created_and_the_turn_is_stored(store, rewrites):
    p = StubPipeline()
    result = chat_turn(p, store, user_id="u", question="Notice period?", trace_id="t1")
    assert result.conversation_id and result.standalone == "Notice period?"
    assert result.text == "The notice period is 30 days." and result.source_ids == ["c1", "c2"]
    turn = store.load(result.conversation_id, "u").turns[0]
    assert (turn.question, turn.rewrite, turn.answer, turn.source_ids, turn.trace_id) == (
        "Notice period?", "Notice period?", "The notice period is 30 days.", ["c1", "c2"], "t1",
    )
    assert rewrites == []


def test_a_second_turn_loads_the_first_and_rewrites(store, rewrites):
    p = StubPipeline()
    first = chat_turn(p, store, user_id="u", question="Tell me about the lease")
    second = chat_turn(p, store, user_id="u", question="And the notice?", conversation_id=first.conversation_id)
    assert second.conversation_id == first.conversation_id
    assert second.standalone == "What is the notice period in the lease?"
    assert p.asked[1]["question"] == second.standalone
    turns = store.load(first.conversation_id, "u").turns
    assert [t.question for t in turns] == ["Tell me about the lease", "And the notice?"]
    assert turns[1].rewrite == second.standalone


def test_a_past_answer_never_reaches_the_answer_step(store, rewrites):
    p = StubPipeline(text="ZEBRA-9731 is the secret figure.")
    first = chat_turn(p, store, user_id="u", question="First?")
    chat_turn(p, store, user_id="u", question="And?", conversation_id=first.conversation_id)
    assert "ZEBRA-9731" in rewrites[0]["user"]  # history may give meaning to the rewrite
    assert "ZEBRA-9731" not in json.dumps(p.asked[1], default=str)
    assert p.asked[1]["question"] == "What is the notice period in the lease?"


def test_roles_and_trace_id_reach_the_pipeline(store, rewrites):
    p = StubPipeline()
    events = []
    chat_turn(p, store, user_id="u", question="Q?", roles=["hr"], credentials={"k": "v"}, trace_id="t9", on_event=events.append)
    asked = p.asked[0]
    assert (asked["roles"], asked["credentials"], asked["trace_id"]) == (["hr"], {"k": "v"}, "t9")
    assert asked["on_event"] is not None


def test_another_users_conversation_id_starts_nothing_and_leaks_nothing(store, rewrites):
    p = StubPipeline()
    mine = chat_turn(p, store, user_id="a", question="Private?")
    with pytest.raises(ConversationNotFound):
        chat_turn(p, store, user_id="b", question="Hi", conversation_id=mine.conversation_id)
    assert len(p.asked) == 1
    assert len(store.load(mine.conversation_id, "a").turns) == 1


def test_a_failed_answer_stores_no_turn(store, rewrites):
    p = StubPipeline(ok=False)
    result = chat_turn(p, store, user_id="u", question="Q?")
    assert result.text == "" and result.source_ids == [] and not result.answer.ok
    assert store.load(result.conversation_id, "u") is None


def test_the_chat_rewrite_event_is_json(store, rewrites):
    events = []
    p = StubPipeline()
    first = chat_turn(p, store, user_id="u", question="Q?", on_event=events.append)
    chat_turn(p, store, user_id="u", question="And?", conversation_id=first.conversation_id, on_event=events.append)
    rewrite = [e for e in events if e.get("event") == "chat_rewrite"]
    assert [e["reason"] for e in rewrite] == ["no history", "rewritten"]
    assert rewrite[1]["standalone"] == "What is the notice period in the lease?"
    json.dumps(rewrite)


def test_search_answers_report_the_found_pieces_as_sources(store, rewrites):
    class SearchStub(StubPipeline):
        def ask(self, question, **kwargs):
            answer = super().ask(question, **kwargs)
            answer.output.payload = {"results": [{"chunk_id": "r1"}, {"chunk_id": "r2"}]}
            return answer

    result = chat_turn(SearchStub(), store, user_id="u", question="Q?")
    assert result.source_ids == ["r1", "r2"]


def test_a_real_pipeline_accepts_the_arguments(store, tmp_path, rewrites):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "a.pdf").write_bytes(build_pdf([["Bees dance to show the hive where the flowers are."]]))
    p = Pipeline(
        path=tmp_path / "index", parse="pdfium", embed="fake-deterministic", store="lancedb",
        chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        search={"use": "hybrid_rrf", "top_k": 3}, answer={"use": "search"},
    )
    p.index.run(folder)
    result = chat_turn(p, store, user_id="u", question="How do bees show the hive the flowers?", roles=None, trace_id="t")
    assert result.answer.ok and result.text and result.source_ids
