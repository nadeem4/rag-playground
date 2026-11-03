"""pandion review lists flagged traces, and with --evaluate scores them."""

import pytest

from pandion import cli, online
from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.extend import online_evaluator
from pandion.trace_record import Feedback, TraceRecord

VAR = "PANDION_TEST_REVIEW_URL"


@pytest.fixture(autouse=True)
def clean_registry():
    before = dict(online.EVALUATORS)
    yield
    online.EVALUATORS.clear()
    online.EVALUATORS.update(before)


@pytest.fixture
def store(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'r.db').as_posix()}"
    monkeypatch.setenv(VAR, url)
    s = SqlStore(SqlSettings(url=url))
    s.save_trace(TraceRecord(trace_id="ok", user_id="u", conversation_id="c", question="fine?", answer="yes"))
    s.save_trace(TraceRecord(trace_id="bad", user_id="u", conversation_id="c", question="odd\x1b[31m?", answer="no", flags=["low_grounding"]))
    s.save_trace(TraceRecord(trace_id="down", user_id="u", conversation_id="c", question="meh?", answer="x"))
    s.add_feedback("down", "u", Feedback(value="down"))
    return s


def test_review_without_evaluate_lists_flagged_traces(store, capsys):
    assert cli.main(["review", "--url-env", VAR]) == 0
    out = capsys.readouterr().out
    assert "bad" in out and "low_grounding" in out and "down" in out and "thumbs down" in out
    assert "ok " not in out and "\x1b" not in out


def test_review_with_nothing_to_look_at_says_so(tmp_path, monkeypatch, capsys):
    url = f"sqlite:///{(tmp_path / 'e.db').as_posix()}"
    monkeypatch.setenv(VAR, url)
    SqlStore(SqlSettings(url=url))
    assert cli.main(["review", "--url-env", VAR]) == 0
    assert "No flagged" in capsys.readouterr().out


def test_review_evaluate_scores_and_prints_counts(store, capsys):
    online_evaluator("len", version="1", outputs={"n": "float"})(lambda t: {"n": float(len(t.answer))})
    assert cli.main(["review", "--evaluate", "--url-env", VAR]) == 0
    assert "len@1: 3 scored" in capsys.readouterr().out
    assert store.trace("ok").scores == {"len@1.n": 3.0}


def test_review_evaluate_reports_a_failure_by_type_and_exits_0(store, capsys):
    def boom(t):
        raise KeyError(t.question)
    online_evaluator("boom", version="1", outputs={"n": "float"})(boom)
    assert cli.main(["review", "--evaluate", "--url-env", VAR]) == 0
    err = capsys.readouterr().err
    assert "boom@1: 3 failed (KeyError: 3)" in err and "fine" not in err


def test_review_evaluate_only_sample_and_rerun(store, capsys):
    online_evaluator("a", version="1", outputs={"n": "float"})(lambda t: {"n": 1.0})
    online_evaluator("b", version="1", outputs={"n": "float"})(lambda t: {"n": 1.0})
    cli.main(["review", "--evaluate", "--only", "a", "--sample", "100%", "--url-env", VAR])
    assert set(store.trace("ok").scores) == {"a@1.n"}
    capsys.readouterr()
    cli.main(["review", "--evaluate", "--only", "a", "--url-env", VAR])
    assert "3 skipped" in capsys.readouterr().out
    cli.main(["review", "--evaluate", "--only", "a", "--rerun", "--sample", "0", "--url-env", VAR])
    assert "0 scored" in capsys.readouterr().out


def test_review_evaluate_with_an_unknown_name_exits_1_with_a_sentence(store, capsys):
    online_evaluator("a", version="1", outputs={"n": "float"})(lambda t: {"n": 1.0})
    assert cli.main(["review", "--evaluate", "--only", "nope", "--url-env", VAR]) == 1
    assert "no online evaluator named 'nope'" in capsys.readouterr().err


def test_review_evaluate_with_none_registered_says_so(store, capsys):
    assert cli.main(["review", "--evaluate", "--url-env", VAR]) == 1
    assert "No online evaluators" in capsys.readouterr().err


def test_a_bad_sample_is_a_sentence(store, capsys):
    assert cli.main(["review", "--evaluate", "--sample", "lots", "--url-env", VAR]) == 1
    assert "--sample" in capsys.readouterr().err


def test_review_evaluate_loads_the_plugins_flag(store, monkeypatch):
    from pathlib import Path
    import sys
    monkeypatch.chdir(Path(__file__).resolve().parents[3] / "examples" / "pandion" / "extensions")
    try:
        assert cli.main(["review", "--evaluate", "--plugins", "answer_length_evaluator", "--url-env", VAR]) == 0
    finally:
        sys.modules.pop("answer_length_evaluator", None)
    assert store.trace("ok").scores["answer_length@1.words"] == 1.0


def test_review_says_when_it_read_only_the_newest_traces(store, monkeypatch, capsys):
    monkeypatch.setattr(cli, "TRACE_LIMIT", 2)
    cli.main(["review", "--url-env", VAR])
    assert "Only the newest" in capsys.readouterr().err


def test_review_evaluate_says_when_it_read_only_the_newest_traces(store, monkeypatch, capsys):
    monkeypatch.setattr(cli, "TRACE_LIMIT", 2)
    online_evaluator("len", version="1", outputs={"n": "float"})(lambda t: {"n": float(len(t.answer))})
    assert cli.main(["review", "--evaluate", "--url-env", VAR]) == 0
    assert "Only the newest" in capsys.readouterr().err
