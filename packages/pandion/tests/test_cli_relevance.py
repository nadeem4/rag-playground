"""pandion review --evaluate --judge adds the built-in relevance evaluator; without --judge it never runs."""

import pytest

from pandion import cli, online
from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.extend import online_evaluator
from pandion.llm import Completion
from pandion.trace_record import TraceRecord, TraceSource

VAR = "PANDION_TEST_RELEVANCE_URL"


@pytest.fixture(autouse=True)
def clean_registry():
    before = dict(online.EVALUATORS)
    online.EVALUATORS.clear()
    yield
    online.EVALUATORS.clear()
    online.EVALUATORS.update(before)


@pytest.fixture
def calls(monkeypatch):
    seen = []

    def fake(model, **kwargs):
        seen.append(kwargs)
        return Completion(text='{"score": 0.8, "reason": "ok"}', usage={}, stop_reason="end_turn")

    monkeypatch.setattr("pandion.llm.complete", fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    return seen


@pytest.fixture
def store(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'r.db').as_posix()}"
    monkeypatch.setenv(VAR, url)
    s = SqlStore(SqlSettings(url=url))
    s.save_trace(TraceRecord(trace_id="with", user_id="u", conversation_id="c", question="q?", answer="a",
                             sources=[TraceSource(id="s1", text="passage")]))
    s.save_trace(TraceRecord(trace_id="without", user_id="u", conversation_id="c", question="q?", answer="a"))
    return s


def test_relevance_runs_only_with_judge(store, calls, capsys):
    online_evaluator("len", version="1", outputs={"n": "float"})(lambda t: {"n": 1.0})
    assert cli.main(["review", "--evaluate", "--url-env", VAR]) == 0
    assert calls == []
    assert not any(k.startswith("relevance") for k in store.trace("with").scores)


def test_relevance_skips_traces_without_sources(store, calls, capsys):
    assert cli.main(["review", "--evaluate", "--judge", "--url-env", VAR]) == 0
    out = capsys.readouterr().out
    assert store.trace("with").scores == {"relevance@1.score": 0.8}
    assert store.trace("without").scores == {}
    assert len(calls) == 1
    assert "relevance@1: 1 scored" in out and "1 skipped" in out


def test_a_judge_failure_is_counted_like_any_evaluator_failure(store, calls, monkeypatch, capsys):
    monkeypatch.setattr("pandion.llm.complete", lambda model, **kw: Completion(text="garbage", usage={}, stop_reason="end_turn"))
    assert cli.main(["review", "--evaluate", "--judge", "--url-env", VAR]) == 0
    assert "relevance@1: 1 failed" in capsys.readouterr().err
    assert store.trace("with").scores == {}


def test_only_relevance_without_judge_says_it_needs_judge(store, capsys):
    assert cli.main(["review", "--evaluate", "--only", "relevance", "--url-env", VAR]) == 1
    assert "--judge" in capsys.readouterr().err
