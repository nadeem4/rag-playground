"""The parsing lab's recording: `scripts/record_parsing_lab.py`.

The fast half checks the committed JSON against the current samples and the
excerpt helper on small strings. The slow half, marked `models`, re-runs the
real pipeline (pdfium, Docling and Qwen3) and compares it to the committed file.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RECORDED = ROOT / "web" / "src" / "learn" / "parsing-lab.json"
CASES = ["two-column-report", "table-of-figures", "scanned-notes"]


def _script():
    spec = importlib.util.spec_from_file_location(
        "record_parsing_lab", ROOT / "scripts" / "record_parsing_lab.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_recording_matches_the_samples():
    from api.sample_set import all_samples

    data = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert [c["name"] for c in data["cases"]] == CASES
    shas = {s.name: s.sha for s in all_samples()}
    for case in data["cases"]:
        assert set(case["parsers"]) == {"pdfium", "docling"}
        assert case["sha"] == shas[case["name"]]


def test_excerpt_window():
    excerpt = _script().excerpt
    filler = " ".join(f"word{i}" for i in range(80))
    text = f"{filler}  The Survey\nran for six   weeks in spring. {filler}"
    out = excerpt(text, "The survey ran for six weeks.")
    assert out is not None
    assert len(out) == 160
    assert "The Survey ran for six weeks" in out
    assert excerpt(text, "Nothing like this sentence is here.") is None
    assert excerpt("", "The survey ran for six weeks.") is None


@pytest.mark.models
def test_a_fresh_run_matches_the_committed_json(tmp_path):
    out = tmp_path / "parsing-lab.json"
    fresh = _script().record(out)
    committed = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert [c["name"] for c in fresh["cases"]] == [c["name"] for c in committed["cases"]]
    for f, c in zip(fresh["cases"], committed["cases"]):
        assert list(f["parsers"]) == list(c["parsers"])
        for parser in c["parsers"]:
            assert f["parsers"][parser].get("hits") == c["parsers"][parser].get("hits")
    assert json.loads(out.read_text(encoding="utf-8")) == fresh


def test_seconds_are_one_decimal_and_never_zero():
    seconds = _script().seconds
    assert seconds(12) == 0.1
    assert seconds(0) == 0.1
    assert seconds(2345) == 2.3


def test_the_warm_up_covers_every_parse_config_on_a_sample_that_is_not_a_case():
    script = _script()
    assert script.WARM_UP not in script.CASES
    configs = {(p, tuple(sorted(script.parse_config(p, c).items()))) for c in script.CASES for p in script.PARSERS}
    warmed = {(p, tuple(sorted(cfg.items()))) for p, cfg in script.WARM_UP_CONFIGS}
    assert configs <= warmed
