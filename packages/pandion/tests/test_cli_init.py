"""`pandion init FOLDER`: a project folder from two templates."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import yaml

import pandion
from pandion.cli import main


def test_init_with_flags_writes_the_project_and_the_next_steps(tmp_path, capsys):
    folder = tmp_path / "project"
    assert main(["init", str(folder), "--index", "text", "--query", "balanced"]) == 0

    out = capsys.readouterr().out
    assert yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8")) == pandion.Pipeline.from_dict(
        pandion.compose_template("text", "balanced")
    ).to_dict() | {"path": "./pandion-index"}
    for name in ("pipeline.yaml", "run.py", "README.md", "requirements.txt"):
        assert name in out
    assert "pip install -r requirements.txt" in out and "python run.py" in out


def test_init_adds_a_question_set(tmp_path, capsys):
    questions = tmp_path / "set.json"
    questions.write_text(json.dumps([{"question": "Why?", "gold_answers": ["Because."]}]), encoding="utf-8")
    folder = tmp_path / "project"
    assert main(["init", str(folder), "--index", "text", "--query", "balanced", "--questions", str(questions)]) == 0
    assert (folder / "questions.json").is_file()


def test_init_refuses_a_folder_with_files_unless_overwrite(tmp_path, capsys):
    (tmp_path / "notes.txt").write_text("mine", encoding="utf-8")
    assert main(["init", str(tmp_path), "--index", "text", "--query", "balanced"]) == 2
    assert "--overwrite" in capsys.readouterr().err
    assert main(["init", str(tmp_path), "--index", "text", "--query", "balanced", "--overwrite"]) == 0


def test_init_names_the_templates_when_one_is_unknown(tmp_path, capsys):
    assert main(["init", str(tmp_path / "p"), "--index", "nope", "--query", "balanced"]) == 2
    assert "manuals, scanned, tables, text" in capsys.readouterr().err


def test_init_without_flags_and_no_terminal_says_to_pass_them(tmp_path):
    out = subprocess.run(
        [sys.executable, "-m", "pandion.cli", "init", "project"],
        cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", input="", timeout=600,
    )
    assert out.returncode == 2
    assert "--index" in out.stderr and "--query" in out.stderr
    assert not (tmp_path / "project").exists()


def test_init_asks_for_each_half_at_a_terminal(tmp_path, capsys, monkeypatch):
    index = [t["id"] for t in pandion.list_templates()["index"]]
    query = [t["id"] for t in pandion.list_templates()["query"]]
    answers = io.StringIO(f"{index.index('tables') + 1}\nnine\n{query.index('exact') + 1}\n")
    answers.isatty = lambda: True
    monkeypatch.setattr(sys, "stdin", answers)

    folder = tmp_path / "project"
    assert main(["init", str(folder)]) == 0

    out = capsys.readouterr().out
    first = pandion.list_templates()["index"][0]
    assert f"1. {first['name']} ({first['id']}): {first['summary']}" in out
    assert "Type a number" in out
    written = yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))
    expected = pandion.Pipeline.from_dict(pandion.compose_template("tables", "exact")).to_dict()
    assert written["index"] == expected["index"] and written["retrieve"] == expected["retrieve"]


def test_init_on_a_file_says_so_plainly(tmp_path, capsys):
    target = tmp_path / "project"
    target.write_text("x", encoding="utf-8")
    assert main(["init", str(target), "--index", "text", "--query", "balanced"]) == 2
    assert "is a file, not a folder" in capsys.readouterr().err


def test_the_cd_line_quotes_a_folder_with_spaces(tmp_path, capsys):
    folder = tmp_path / "my project"
    assert main(["init", str(folder), "--index", "text", "--query", "balanced"]) == 0
    assert f'cd "{folder}"' in capsys.readouterr().out


def test_ctrl_c_at_the_prompt_exits_quietly_with_130(tmp_path, capsys, monkeypatch):
    stdin = io.StringIO("")
    stdin.isatty = lambda: True
    monkeypatch.setattr(sys, "stdin", stdin)

    def interrupted(prompt=""):
        raise KeyboardInterrupt

    monkeypatch.setattr("builtins.input", interrupted)
    assert main(["init", str(tmp_path / "project")]) == 130
    assert "Traceback" not in capsys.readouterr().err
    assert not (tmp_path / "project").exists()
