"""pandion trace prints one trace record from a conversation store."""

import json

import pytest

from pandion import cli
from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.trace_record import Feedback, TraceRecord

VAR = "PANDION_TEST_TRACE_URL"


@pytest.fixture
def db(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 't.db').as_posix()}"
    monkeypatch.setenv(VAR, url)
    store = SqlStore(SqlSettings(url=url))
    store.save_trace(TraceRecord(
        trace_id="t1", user_id="alice", conversation_id="c1", question="What is chunking?",
        standalone="What is chunking in RAG?", answer="Cutting text into pieces.", label="cited",
        source_ids=["s1"], stages=[{"name": "retrieve", "ms": 12, "dollars": None}, {"name": "answer", "ms": 800, "dollars": 0.0012}],
        cost=0.0012, latency_ms=812, flags=["low_grounding"],
    ))
    store.add_feedback("t1", "alice", Feedback(value="down", comment="too short"))
    return store


def test_trace_prints_question_label_stages_and_cost(db, capsys):
    code = cli.main(["trace", "t1", "--url-env", VAR])
    out = capsys.readouterr().out
    assert code == 0
    for text in ("What is chunking?", "cited", "retrieve", "answer", "800", "$0.0012", "low_grounding", "down"):
        assert text in out


def test_trace_json_is_the_record(db, capsys):
    code = cli.main(["trace", "t1", "--url-env", VAR, "--json"])
    data = json.loads(capsys.readouterr().out)
    assert code == 0 and data == db.trace("t1").model_dump()


def test_trace_missing_id_exits_1_with_a_sentence(db, capsys):
    code = cli.main(["trace", "nope", "--url-env", VAR])
    err = capsys.readouterr().err
    assert code == 1 and "nope" in err and err.count("\n") == 1


def test_trace_on_a_store_without_traces_says_so(monkeypatch, capsys):
    monkeypatch.setattr(cli, "get_conversation_store", lambda name, settings=None: object())
    code = cli.main(["trace", "t1", "--url-env", VAR])
    assert code == 1 and "does not keep traces" in capsys.readouterr().err


def test_trace_strips_control_characters(db, capsys):
    db.save_trace(TraceRecord(trace_id="t2", user_id="alice", conversation_id="c", question="hi\x1b[31m red",
                              answer="a\x07b\nsecond line", label="cited"))
    db.add_feedback("t2", "alice", Feedback(value="up", comment="c\x1b[0mx"))
    cli.main(["trace", "t2", "--url-env", VAR])
    out = capsys.readouterr().out
    assert "\x1b" not in out and "\x07" not in out and "second line" in out
