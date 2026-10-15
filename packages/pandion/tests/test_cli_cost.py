"""The cost line `pandion eval` and `pandion compare` print, and the cost in their JSON."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pandion import cli

CONFIG = """\
path: ./index
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
retrieve:
  search: {use: dense}
"""

FULL = {
    "seconds": 1.8412,
    "input_tokens": 2310,
    "output_tokens": 412,
    "dollars": 0.00412,
    "unpriced_models": ["openrouter/auto"],
    "uncounted_models": [],
    "steps_run": 5,
    "steps_cached": 2,
    "prices_as_of": "2026-10-15",
}

LOCAL = {
    "seconds": 0.5,
    "input_tokens": None,
    "output_tokens": None,
    "dollars": None,
    "unpriced_models": [],
    "uncounted_models": [],
    "steps_run": 3,
    "steps_cached": 4,
    "prices_as_of": "2026-10-15",
}


@pytest.mark.parametrize(
    ("cost", "line"),
    [
        (FULL, "Cost: 1.84 s, 2,310 in / 412 out tokens, about $0.0041 (estimate, prices as of 2026-10-15); "
               "2 of 7 steps cached; no price for openrouter/auto"),
        (LOCAL, "Cost: 0.50 s; 4 of 7 steps cached"),
        ({**LOCAL, "input_tokens": 12, "unpriced_models": ["llama3"]},
         "Cost: 0.50 s, 12 in tokens; 4 of 7 steps cached; no price for llama3"),
        ({**FULL, "dollars": 0.00001, "unpriced_models": [], "prices_as_of": "custom"},
         "Cost: 1.84 s, 2,310 in / 412 out tokens, under $0.0001 (estimate, your prices); 2 of 7 steps cached"),
    ],
)
def test_the_cost_line_leaves_out_what_is_unknown(cost, line):
    assert cli.cost_line(cost) == line


class FakeReport:
    questions: list = []

    def __str__(self) -> str:
        return "capital found at rank 1\nFound 1 of 1 (100%). Mean reciprocal rank 1.00."

    def to_dict(self) -> dict:
        return {"total": 1}

    def cost(self) -> dict:
        return FULL


class FakeComparison:
    def __init__(self, name: str, cost: dict) -> None:
        self.name, self._cost = name, cost
        self.index = type("I", (), {"ok": True})()

    def __str__(self) -> str:
        return f"chunk recursive_character chunk_size={self.name}: found 1 of 1"

    def cost(self) -> dict:
        return self._cost


class FakeComparisons(list):
    def __str__(self) -> str:
        return "\n".join([*(str(c) for c in self), "Best: chunk_size=70, found 1 of 1."])

    def to_dict(self) -> dict:
        return {"comparisons": [{"variant": c.name} for c in self], "best": [0]}


@pytest.fixture
def config(tmp_path: Path) -> str:
    path = tmp_path / "pipeline.yaml"
    path.write_text(CONFIG, encoding="utf-8")
    return str(path)


def test_a_missing_count_is_said_as_such():
    cost = {**LOCAL, "input_tokens": 12, "uncounted_models": ["gpt-6-astra"]}
    assert cli.cost_line(cost) == "Cost: 0.50 s, 12 in tokens; 4 of 7 steps cached; no token count for gpt-6-astra"


def test_eval_prints_the_cost_line_after_the_report(config, monkeypatch, capsys):
    monkeypatch.setattr(cli.pandion, "evaluate", lambda *a, **kw: FakeReport())
    assert cli.main(["eval", config, "q.json"]) == 0
    assert capsys.readouterr().out == (
        "capital found at rank 1\n"
        "Found 1 of 1 (100%). Mean reciprocal rank 1.00.\n"
        "Cost: 1.84 s, 2,310 in / 412 out tokens, about $0.0041 (estimate, prices as of 2026-10-15); "
        "2 of 7 steps cached; no price for openrouter/auto\n"
    )


def test_eval_json_holds_the_cost(config, monkeypatch, capsys):
    monkeypatch.setattr(cli.pandion, "evaluate", lambda *a, **kw: FakeReport())
    cli.main(["eval", config, "q.json", "--json"])
    assert json.loads(capsys.readouterr().out) == {"total": 1, "cost": FULL}


def test_compare_prints_a_cost_line_under_each_variant(config, monkeypatch, capsys):
    results = FakeComparisons([FakeComparison("70", FULL), FakeComparison("200", LOCAL)])
    monkeypatch.setattr(cli.pandion, "compare", lambda *a, **kw: results)
    assert cli.main(["compare", config, "--vary", "chunk.chunk_size=70,200", "docs"]) == 0
    assert capsys.readouterr().out == (
        "chunk recursive_character chunk_size=70: found 1 of 1\n"
        "  Cost: 1.84 s, 2,310 in / 412 out tokens, about $0.0041 (estimate, prices as of 2026-10-15); "
        "2 of 7 steps cached; no price for openrouter/auto\n"
        "chunk recursive_character chunk_size=200: found 1 of 1\n"
        "  Cost: 0.50 s; 4 of 7 steps cached\n"
        "Best: chunk_size=70, found 1 of 1.\n"
    )


def test_compare_json_holds_each_variants_cost(config, monkeypatch, capsys):
    results = FakeComparisons([FakeComparison("70", FULL), FakeComparison("200", LOCAL)])
    monkeypatch.setattr(cli.pandion, "compare", lambda *a, **kw: results)
    cli.main(["compare", config, "--vary", "chunk.chunk_size=70,200", "docs", "--json"])
    data = json.loads(capsys.readouterr().out)
    assert [c["cost"] for c in data["comparisons"]] == [FULL, LOCAL]


def test_compare_keeps_each_cost_line_under_a_variant_that_prints_two_lines(config, monkeypatch, capsys):
    two = FakeComparison("a\nb", FULL)
    results = FakeComparisons([two, FakeComparison("200", LOCAL)])
    monkeypatch.setattr(cli.pandion, "compare", lambda *a, **kw: results)
    cli.main(["compare", config, "--vary", "chunk.chunk_size=70,200", "docs"])
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "chunk recursive_character chunk_size=a"
    assert out[1] == "b: found 1 of 1"
    assert out[2].startswith("  Cost: 1.84 s")
    assert out[3] == "chunk recursive_character chunk_size=200: found 1 of 1"
    assert out[4].startswith("  Cost: 0.50 s")
    assert out[5] == "Best: chunk_size=70, found 1 of 1."
