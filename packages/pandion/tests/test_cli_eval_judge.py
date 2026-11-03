"""pandion eval --judge, --judge-model and --judge-gate: off by default, report-only unless gated."""

from __future__ import annotations

import json

import pytest

from pandion import cli
from pandion.evaluation import EvaluationReport, QuestionResult
from pandion.judge import JudgeTally
from test_cli_eval_gate import ENV, run  # noqa: F401  (the fixture)


def judged(mean: float) -> EvaluationReport:
    qs = [
        QuestionResult(
            id=f"q{i}", question=f"q{i}?", golds=["g"], tags=[], found=True, rank=1,
            lost_at=None, trace=None, score={}, judge={"score": mean, "reason": ""},
        )
        for i in range(2)
    ]
    return EvaluationReport(top_k=5, questions=qs, judge=JudgeTally())


def baseline(folder, mean: float) -> str:
    data = judged(mean).to_dict()
    data["environment"] = {"platform": ENV, "models": ["fake-deterministic"], "pandion": "0.0.1"}
    path = folder / "judged.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


@pytest.fixture
def seen(run, monkeypatch):  # noqa: F811
    calls = []
    inner = cli.pandion.evaluate

    def evaluate(*a, **kw):
        calls.append(kw.get("judge"))
        return inner(*a, **kw)

    monkeypatch.setattr(cli.pandion, "evaluate", evaluate)
    return calls


def test_judge_is_off_without_the_flag(run, seen):
    run()
    assert seen[0].on is False and seen[0].gate is False


def test_judge_flags_reach_the_settings(run, seen):
    run("--judge", "--judge-model", "claude-sonnet-5")
    assert (seen[0].on, seen[0].model, seen[0].gate) == (True, "claude-sonnet-5", False)


def test_judge_model_without_judge_is_refused(run):
    code, _, err = run("--judge-model", "claude-sonnet-5")
    assert code == 2 and "--judge" in err
    assert run.state["searches"] == 0


def test_judge_gate_without_a_baseline_is_refused(run):
    code, _, err = run("--judge", "--judge-gate")
    assert code == 2 and "--baseline" in err
    assert run.state["searches"] == 0


def test_an_unknown_judge_model_is_refused(run):
    code, _, err = run("--judge", "--judge-model", "nope")
    assert code == 2 and "not a chat model" in err


def test_gate_fails_the_run_when_correctness_drops(run):
    run.state["report"] = judged(0.6)
    code, out, _ = run("--judge", "--judge-gate", "--baseline", baseline(run.tmp, 0.8))
    assert code == 1
    assert "Mean correctness fell by more than 0.05" in out


def test_a_drop_does_not_fail_without_the_gate(run):
    run.state["report"] = judged(0.6)
    code, out, _ = run("--judge", "--baseline", baseline(run.tmp, 0.8))
    assert code == 0
    assert "Mean correctness 0.60; the baseline's was 0.80." in out


def test_json_carries_the_judge_numbers(run):
    run.state["report"] = judged(0.9)
    code, out, _ = run("--judge", "--json")
    data = json.loads(out)
    assert code == 0 and data["correctness_mean"] == 0.9 and data["judged"] == 2
