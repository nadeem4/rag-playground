"""pandion eval checks the question set against the current parse before it searches."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from pandion import cli
from test_cli_commands import PIPELINE, folder  # noqa: F401

GOOD = {"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}
GONE = {"id": "spain", "question": "What is the capital of Spain?", "gold_answers": ["Madrid is the capital of Spain."]}


@pytest.fixture
def run(folder: Path, monkeypatch, capsys):
    monkeypatch.chdir(folder)
    searched = []
    real = cli.pandion.evaluate
    monkeypatch.setattr(cli.pandion, "evaluate", lambda *a, **kw: searched.append(1) or real(*a, **kw))

    def go(questions: list[dict], *args: str) -> tuple[int, str, str]:
        (folder / "q.json").write_text(json.dumps(questions), encoding="utf-8")
        code = cli.main(["eval", "pipeline.yaml", "q.json", "--documents", "report.pdf", *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    go.searched, go.folder = searched, folder
    return go


def test_a_stale_set_exits_1_and_names_the_questions_on_stderr(run):
    code, out, err = run([GOOD, GONE])
    assert code == 1 and out == ""
    assert "The question set is stale: 1 expected passage is not in the current parse" in err and "spain" in err


def test_a_stale_set_runs_no_search(run, monkeypatch):
    from pandion.pipeline import RetrievalPipeline as Retrieval

    monkeypatch.setattr(Retrieval, "_retrieve", lambda *a, **k: pytest.fail("searched"))
    run([GONE])
    assert run.searched == []


def test_a_good_set_runs_as_before(run):
    code, out, err = run([GOOD])
    assert code == 0 and "capital found at rank" in out and err == ""


def test_a_long_passage_warns_on_stderr_and_still_scores(run):
    small = {**PIPELINE, "index": {**PIPELINE["index"], "chunk": {"use": "recursive_character", "chunk_size": 30, "chunk_overlap": 0}}}
    (run.folder / "pipeline.yaml").write_text(yaml.safe_dump(small, sort_keys=False), encoding="utf-8")
    code, out, err = run([GOOD])
    assert code == 0 and "Found" in out
    assert "capital: the expected passage is 31 characters, longer than the biggest piece (30)" in err
    assert run.searched == [1]


def test_stale_json_shape(run):
    code, out, _ = run([GONE], "--json")
    assert code == 1 and json.loads(out) == {"stale": ["spain"], "warnings": []}


def test_record_baseline_refuses_a_stale_set(run):
    path = run.folder / "evals" / "baseline.json"
    code, _, err = run([GONE], "--record-baseline", str(path))
    assert code == 1 and "stale" in err and not path.exists()
