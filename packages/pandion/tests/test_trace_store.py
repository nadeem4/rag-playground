"""The sql store keeps trace records and feedback, and forgets them with their user."""

import itertools
from datetime import UTC, datetime, timedelta

import pytest

from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.conversation_store import TraceStore, Turn
from pandion.errors import FormatTooNew
from pandion.testing import trace_store_conformance
from pandion.trace_record import Feedback
from trace_helpers import make_record


def make_store(tmp_path, name="t.db"):
    return SqlStore(SqlSettings(url=f"sqlite:///{(tmp_path / name).as_posix()}"))


def ago(days):
    return (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec="seconds")


def test_the_sql_store_is_a_trace_store(tmp_path):
    assert isinstance(make_store(tmp_path), TraceStore)


def test_the_sql_store_passes_the_trace_conformance_suite(tmp_path):
    count = itertools.count()
    trace_store_conformance(lambda: make_store(tmp_path, f"c{next(count)}.db"))


def test_save_and_read_trace(tmp_path):
    store = make_store(tmp_path)
    store.save_trace(make_record(flags=["declined"]))
    got = store.trace("t1", "u1")
    assert got is not None and got.question == "q" and got.flags == ["declined"] and got.created_at


def test_trace_is_not_listed_for_other_users(tmp_path):
    store = make_store(tmp_path)
    store.save_trace(make_record())
    assert store.trace("t1", "u2") is None
    assert store.trace("t1") is not None  # no user: the operator's view (the CLI)
    assert store.add_feedback("t1", "u2", Feedback(value="up")) is False


def test_traces_since_and_flagged_only(tmp_path):
    store = make_store(tmp_path)
    store.save_trace(make_record(trace_id="old", created_at=ago(10)))
    store.save_trace(make_record(trace_id="new", created_at=ago(1)))
    store.save_trace(make_record(trace_id="bad", created_at=ago(0), flags=["low_grounding"]))
    assert [r.trace_id for r in store.traces()] == ["bad", "new", "old"]  # newest first
    assert [r.trace_id for r in store.traces(since=ago(3))] == ["bad", "new"]
    assert [r.trace_id for r in store.traces(flagged_only=True)] == ["bad"]
    assert len(store.traces(limit=2)) == 2


def test_feedback_and_scores_are_kept_on_the_trace(tmp_path):
    store = make_store(tmp_path)
    store.save_trace(make_record())
    assert store.add_feedback("t1", "u1", Feedback(value="down", comment="wrong")) is True
    assert store.add_feedback("missing", "u1", Feedback(value="up")) is False
    store.save_scores("t1", {"relevance": 0.5})
    got = store.trace("t1")
    assert [f.value for f in got.feedback] == ["down"] and got.feedback[0].created_at
    assert got.scores == {"relevance": 0.5}


def test_delete_user_removes_traces_and_feedback(tmp_path):
    store = make_store(tmp_path)
    store.append("c1", "u1", Turn(question="q", answer="a"))
    store.save_trace(make_record())
    store.add_feedback("t1", "u1", Feedback(value="up"))
    store.save_trace(make_record(trace_id="t2", user_id="u2", conversation_id="c2"))
    store.delete_user("u1")
    assert store.trace("t1") is None
    assert [r.trace_id for r in store.traces()] == ["t2"]
    store.save_trace(make_record())  # the same id again: no old feedback came back
    assert store.trace("t1").feedback == []


def test_expire_removes_traces_of_expired_conversations(tmp_path):
    store = make_store(tmp_path)
    store.append("old", "u1", Turn(question="q", answer="a", created_at=ago(40)))
    store.append("new", "u1", Turn(question="q", answer="a"))
    store.save_trace(make_record(trace_id="t-old", conversation_id="old"))
    store.add_feedback("t-old", "u1", Feedback(value="up"))
    store.save_trace(make_record(trace_id="t-new", conversation_id="new"))
    assert store.expire(30) == 1
    assert [r.trace_id for r in store.traces()] == ["t-new"]


def test_deleting_a_conversation_removes_its_traces(tmp_path):
    store = make_store(tmp_path)
    store.append("c1", "u1", Turn(question="q", answer="a"))
    store.save_trace(make_record())
    store.delete("c1", "u1")
    assert store.trace("t1") is None


def test_the_engine_hides_statement_parameters(tmp_path):
    store = make_store(tmp_path)
    store.check()
    assert store._engine.hide_parameters is True


def test_save_trace_never_replaces_another_users_trace(tmp_path):
    store = make_store(tmp_path)
    store.save_trace(make_record(answer="mine"))
    with pytest.raises(ValueError):
        store.save_trace(make_record(user_id="u2"))
    assert store.trace("t1", "u1").answer == "mine"


def test_expire_removes_old_orphaned_traces_and_their_feedback(tmp_path):
    store = make_store(tmp_path)
    store.save_trace(make_record(trace_id="old", conversation_id="gone", created_at=ago(40)))
    store.add_feedback("old", "u1", Feedback(value="up"))
    store.save_trace(make_record(trace_id="new", conversation_id="gone"))
    store.expire(30)
    assert [r.trace_id for r in store.traces()] == ["new"]
    store.save_trace(make_record(trace_id="old", conversation_id="gone"))
    assert store.trace("old").feedback == []


def test_a_newer_trace_format_is_refused(tmp_path):
    import sqlalchemy as sa

    store = make_store(tmp_path)
    store.save_trace(make_record())
    with store._engine.begin() as conn:
        conn.execute(sa.text("update pandion_schema set value = 9 where key = 'traces'"))
    with pytest.raises(FormatTooNew):
        make_store(tmp_path).traces()
