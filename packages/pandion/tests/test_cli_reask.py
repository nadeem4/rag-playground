"""pandion eval --baseline asks newly missed questions once more when a step can differ (spec 8.4)."""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

import pandion
from test_cli_eval_gate import NOW, baseline_file, q, report, run  # noqa: F401


@pytest.fixture
def flaky(run, monkeypatch):
    """The run's report names a nondeterministic step; a second ask finds a2 or does not."""
    (run.tmp / "q.json").write_text(json.dumps([
        {"id": i, "question": f"What is {i}?", "gold_answer": f"{i} is a thing.", "tags": ["category:" + i[0]]}
        for i in ("a1", "a2", "b1", "b2")
    ]), encoding="utf-8")
    monkeypatch.chdir(run.tmp)
    run.state["report"] = replace(NOW, nondeterministic=["llm_rerank"])
    asked = []

    def again(p, questions, *a, **kw):
        asked.append([x["id"] for x in questions])
        return report(*(q(x["id"], run.state["second_ask_finds"], "a") for x in questions))

    monkeypatch.setattr(pandion.evaluation, "evaluate", again)
    run.state["second_ask_finds"] = True
    run.asked = asked
    return run


def test_a_question_found_on_the_second_ask_passes_the_gate(flaky):
    code, out, _ = flaky("--baseline", baseline_file(flaky.tmp))
    assert code == 0
    assert flaky.asked == [["a2"]]
    assert "Asked again because llm_rerank can differ between runs: a2 (found)." in out


def test_a_question_missed_twice_fails_the_gate(flaky):
    flaky.state["second_ask_finds"] = False
    code, out, _ = flaky("--baseline", baseline_file(flaky.tmp))
    assert code == 1
    assert "a2 (missed again)" in out and 'Category "a" newly missed: a2.' in out


def test_json_lists_the_questions_asked_again(flaky):
    code, out, _ = flaky("--baseline", baseline_file(flaky.tmp), "--json")
    assert code == 0
    assert json.loads(out)["reasked"] == [{"id": "a2", "found": True}]


def test_nothing_is_asked_again_without_a_nondeterministic_step(run):
    code, out, _ = run("--baseline", baseline_file(run.tmp))
    assert code == 1 and "Asked again" not in out
