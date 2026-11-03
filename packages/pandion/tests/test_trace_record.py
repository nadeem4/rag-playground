"""The trace record: one JSON document per chat turn."""

import pytest

from pandion.chat_turn import chat_turn
from pandion.conversation_store import get_conversation_store
from pandion.trace_record import Feedback, TraceRecord
from trace_helpers import StubPipeline, make_record


def test_record_round_trips_through_json():
    record = make_record(flags=["declined"], scores={"relevance": 0.5, "ok": True, "kind": "x"},
                         feedback=[Feedback(value="down", category="wrong", comment="no", created_at="2026-01-01T00:00:00+00:00")],
                         stages=[{"name": "search", "ms": 12, "dollars": None}], cost=0.002)
    assert TraceRecord.model_validate_json(record.model_dump_json()) == record


def test_record_holds_no_credentials(tmp_path):
    store = get_conversation_store("sql", {"url": f"sqlite:///{(tmp_path / 'c.db').as_posix()}"})
    result = chat_turn(StubPipeline(), store, user_id="u", question="Notice?", trace_id="t1",
                       credentials={"anthropic": "sk-secret"})
    record = store.trace("t1")
    assert record is not None and "sk-secret" not in record.model_dump_json()
    assert result.conversation_id == record.conversation_id


def test_feedback_value_is_up_or_down():
    with pytest.raises(ValueError):
        Feedback(value="meh")
