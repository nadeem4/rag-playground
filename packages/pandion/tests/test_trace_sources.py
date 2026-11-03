"""A trace keeps the passages its answer cited, cut short."""

from types import SimpleNamespace

import pytest

from pandion.chat_turn import chat_turn
from pandion.conversation_store import get_conversation_store
from pandion.trace_record import TraceRecord
from trace_helpers import StubPipeline


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{(tmp_path / 'c.db').as_posix()}"})


def test_trace_stores_cited_source_text_cut_to_2000(store):
    hits = [
        SimpleNamespace(chunk=SimpleNamespace(id="c1", text="a" * 5000)),
        SimpleNamespace(chunk=SimpleNamespace(id="other", text="not cited")),
    ]
    chat_turn(StubPipeline(hits=hits), store, user_id="u", question="q", trace_id="src")
    assert [(s.id, len(s.text)) for s in store.trace("src").sources] == [("c1", 2000)]


def test_an_old_trace_without_sources_still_loads():
    old = TraceRecord.model_validate({"trace_id": "t", "user_id": "u", "conversation_id": "c", "question": "q"})
    assert old.sources == []
