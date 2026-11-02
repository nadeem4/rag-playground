"""pandion eval --record-baseline, and the per-category gate with a baseline from the same place."""

from __future__ import annotations

import json
import platform
from pathlib import Path

import pytest
import yaml

from pandion import cli
from pandion.evaluation import EvaluationReport, QuestionResult
from test_cli_commands import PIPELINE

ENV = f"{platform.system()}-{platform.machine()}".lower()


def q(id: str, found: bool, category: str, error: str | None = None) -> QuestionResult:
    return QuestionResult(
        id=id, question=f"What is {id}?", golds=[f"{id} is a thing."], tags=[f"category:{category}"],
        found=found, rank=1 if found else None, lost_at=None if found else "search", trace=None, score={},
        error=error,
    )


def report(*questions: QuestionResult) -> EvaluationReport:
    return EvaluationReport(top_k=5, questions=list(questions))


BEFORE = report(q("a1", True, "a"), q("a2", True, "a"), q("b1", True, "b"), q("b2", False, "b"))
#: a2 is newly missed in a; b2 is newly found in b, so the total is unchanged.
NOW = report(q("a1", True, "a"), q("a2", False, "a"), q("b1", True, "b"), q("b2", True, "b"))


@pytest.fixture
def run(tmp_path, monkeypatch, capsys):
    (tmp_path / "pipeline.yaml").write_text(yaml.safe_dump(PIPELINE, sort_keys=False), encoding="utf-8")
    state = {"report": NOW, "searches": 0}

    def evaluate(*a, **kw):
        state["searches"] += 1
        return state["report"]

    monkeypatch.setattr(cli.pandion, "evaluate", evaluate)

    def go(*args: str) -> tuple[int, str, str]:
        code = cli.main(["eval", str(tmp_path / "pipeline.yaml"), "q.json", *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    go.tmp, go.state = tmp_path, state
    return go


def baseline_file(folder: Path, environment: dict | None = "same") -> str:
    data = BEFORE.to_dict()
    if environment == "same":
        environment = {"platform": ENV, "models": ["fake-deterministic"], "pandion": "0.0.1"}
    if environment is not None:
        data["environment"] = environment
    path = folder / "base.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


def test_record_baseline_writes_the_file_with_an_environment_block(run):
    run.state["report"] = BEFORE
    path = run.tmp / "evals" / "base.json"
    code, out, _ = run("--record-baseline", str(path))
    assert code == 0
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["environment"]["platform"] == ENV and data["environment"]["models"] == ["fake-deterministic"]
    assert f"Baseline recorded at {path} (platform {ENV}, 4 questions)." in out


def test_record_baseline_with_baseline_is_refused(run):
    code, _, err = run("--record-baseline", str(run.tmp / "b.json"), "--baseline", baseline_file(run.tmp))
    assert code == 2 and "--record-baseline" in err and "--baseline" in err
    assert run.state["searches"] == 0


def test_record_baseline_writes_nothing_when_a_question_errors(run):
    run.state["report"] = report(q("a1", True, "a"), q("a2", False, "a", error="boom"))
    path = run.tmp / "b.json"
    code, _, _ = run("--record-baseline", str(path))
    assert code == 1 and not path.exists()


def test_gate_passes_against_its_own_baseline(run):
    run.state["report"] = BEFORE
    assert run("--baseline", baseline_file(run.tmp))[0] == 0


def test_gate_fails_for_one_category_and_names_it(run):
    code, out, _ = run("--baseline", baseline_file(run.tmp))
    assert code == 1
    assert 'Category "a" newly missed: a2.' in out
    assert 'Category "b"' not in out


def test_a_baseline_from_another_platform_exits_2_before_any_search(run):
    other = {"platform": "plan9-mips", "models": ["fake-deterministic"], "pandion": "0.0.1"}
    code, _, err = run("--baseline", baseline_file(run.tmp, other))
    assert code == 2 and "recorded on plan9-mips" in err and "--record-baseline" in err
    assert run.state["searches"] == 0


def test_an_old_baseline_without_environment_still_works_with_a_note(run):
    code, out, _ = run("--baseline", baseline_file(run.tmp, None), "--allow", "1")
    assert code == 0
    assert "The baseline has no environment record" in out


def test_allow_is_per_category(run):
    run.state["report"] = report(q("a1", False, "a"), q("a2", True, "a"), q("b1", False, "b"), q("b2", True, "b"))
    base = baseline_file(run.tmp)
    assert run("--baseline", base)[0] == 1
    assert run("--baseline", base, "--allow", "1")[0] == 0  # two missed in all, one in each


def test_json_holds_the_category_results_and_the_environment(run):
    code, out, _ = run("--baseline", baseline_file(run.tmp), "--json")
    data = json.loads(out)
    assert code == 1
    assert data["regression"]["by_category"]["a"]["newly_missed"] == ["a2"]
    assert data["environment"]["platform"] == ENV


def test_record_baseline_with_json_keeps_stdout_pure_json(run):
    run.state["report"] = BEFORE
    code, out, err = run("--record-baseline", str(run.tmp / "b.json"), "--json")
    assert code == 0
    json.loads(out)  # nothing but the report on stdout
    assert "Baseline recorded at" in err


def test_json_gate_ok_follows_allow_like_the_exit_code(run):
    base = baseline_file(run.tmp)
    code, out, _ = run("--baseline", base, "--json")
    assert code == 1 and json.loads(out)["regression"]["gate_ok"] is False
    code, out, _ = run("--baseline", base, "--json", "--allow", "1")
    assert code == 0 and json.loads(out)["regression"]["gate_ok"] is True


def test_a_missing_baseline_points_to_record_baseline(run):
    code, _, err = run("--baseline", str(run.tmp / "missing.json"))
    assert code == 2 and "--record-baseline" in err and "--json >" not in err
