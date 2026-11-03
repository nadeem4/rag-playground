"""pandion eval on a follow-up case: the rewrite runs, and a failed one is said on stderr."""

from __future__ import annotations

import json

from pandion import cli
from pandion.llm import Completion
from test_cli_commands import folder  # noqa: F401

FOLLOWUP = {
    "id": "followup",
    "question": "And its capital?",
    "gold_answers": ["The capital of France is Paris."],
    "history": [{"question": "Tell me about France.", "answer": "A country in Europe."}],
}


def run(folder, capsys, monkeypatch, fake, *args):
    monkeypatch.chdir(folder)
    monkeypatch.setattr("pandion.llm.complete", fake)
    (folder / "q.json").write_text(json.dumps([FOLLOWUP]), encoding="utf-8")
    code = cli.main(["eval", "pipeline.yaml", "q.json", "--documents", "report.pdf", *args])
    out = capsys.readouterr()
    return code, out.out, out.err


def test_a_followup_is_rewritten_before_the_search(folder, capsys, monkeypatch):
    calls = []

    def fake(model, **kwargs):
        calls.append(kwargs["user"])
        return Completion(text="What is the capital of France?", usage={}, stop_reason="end_turn")

    code, out, err = run(folder, capsys, monkeypatch, fake)
    assert code == 0 and "followup found at rank" in out and len(calls) == 1


def test_a_failed_rewrite_is_said_on_stderr_in_json_mode(folder, capsys, monkeypatch):
    def down(model, **kwargs):
        raise RuntimeError("no key")

    code, out, err = run(folder, capsys, monkeypatch, down, "--json")
    assert json.loads(out)["rewrites_failed"] == 1
    assert "could not be rewritten" in err
