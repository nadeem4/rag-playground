"""pandion report summarises the traces in a conversation store."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from pandion import cli
from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.trace_record import Feedback, TraceRecord
from pandion.trace_report import parse_since, report

VAR = "PANDION_TEST_REPORT_URL"


def rec(i, **kw):
    base = dict(trace_id=f"t{i}", user_id="alice", conversation_id="c", question="q", label="cited", latency_ms=100 * i)
    return TraceRecord(**{**base, **kw})


@pytest.fixture
def store(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'r.db').as_posix()}"
    monkeypatch.setenv(VAR, url)
    return SqlStore(SqlSettings(url=url))


def test_report_counts_labels_and_flags():
    r = report([rec(1), rec(2, label="weak", flags=["low_grounding"]), rec(3, label="weak", flags=["low_grounding", "declined"])])
    assert r.turns == 3 and r.by_label == {"cited": 1, "weak": 2}
    assert r.flagged == {"low_grounding": 2, "declined": 1}


def test_report_percentiles_on_known_latencies():
    r = report([rec(i) for i in range(1, 11)])
    assert r.p50_ms == 550 and r.p95_ms == 955


def test_report_costs_and_feedback():
    fb = [Feedback(value="up"), Feedback(value="down"), Feedback(value="up")]
    r = report([rec(1, cost=0.01, feedback=fb), rec(2, cost=0.03), rec(3)])
    assert r.cost_total == pytest.approx(0.04) and r.cost_mean == pytest.approx(0.02)
    assert r.feedback == {"up": 2, "down": 1}


def test_report_means_include_evaluator_scores():
    r = report([rec(1, scores={"rel": 1.0, "ok": True, "tone": "dry"}), rec(2, scores={"rel": 0.5, "ok": False, "tone": "dry"})])
    assert r.score_means == {"rel": 0.75}
    assert r.score_counts == {"ok: True": 1, "ok: False": 1, "tone: dry": 2}


def test_report_on_no_traces_prints_zero_turns(store, capsys):
    code = cli.main(["report", "--url-env", VAR])
    assert code == 0 and "0 turns" in capsys.readouterr().out
    assert report([]).p50_ms == 0


def test_report_cli_prints_and_json(store, capsys):
    for i in (1, 2):
        store.save_trace(rec(i, flags=["declined"] if i == 2 else []))
    assert cli.main(["report", "--url-env", VAR]) == 0
    out = capsys.readouterr().out
    assert "2 turns" in out and "cited" in out and "declined" in out
    assert cli.main(["report", "--url-env", VAR, "--flagged", "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["turns"] == 1 and data["flagged"] == {"declined": 1}


def test_report_since_24h_leaves_older_out(store, capsys):
    store.save_trace(rec(1))
    store.save_trace(rec(2, created_at=(datetime.now(UTC) - timedelta(days=3)).isoformat()))
    assert cli.main(["report", "--url-env", VAR, "--since", "24h", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["turns"] == 1


def test_report_on_a_store_without_traces_says_so(monkeypatch, capsys):
    monkeypatch.setattr(cli, "get_conversation_store", lambda name, settings=None: object())
    assert cli.main(["report", "--url-env", VAR]) == 1
    assert "does not keep traces" in capsys.readouterr().err


def test_since_accepts_24h_7d_and_iso_dates_and_refuses_the_rest():
    now = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)
    assert parse_since("24h", now=now) == "2026-11-01T12:00:00+00:00"
    assert parse_since("7d", now=now) == "2026-10-26T12:00:00+00:00"
    assert parse_since("2026-10-01", now=now) == "2026-10-01T00:00:00+00:00"
    assert parse_since("2026-10-01T05:00:00+02:00", now=now) == "2026-10-01T03:00:00+00:00"
    for bad in ("", "yesterday", "5m", "-1d", "0h"):
        with pytest.raises(ValueError, match="--since"):
            parse_since(bad, now=now)
