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
BASELINE = "chunking-primer"


def _script():
    spec = importlib.util.spec_from_file_location(
        "record_parsing_lab", ROOT / "scripts" / "record_parsing_lab.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_recording_matches_the_samples():
    """Every case and the baseline match the sample as it is now, questions included."""
    from api.sample_set import all_samples

    data = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert [c["name"] for c in data["cases"]] == CASES
    assert data["baseline"]["name"] == BASELINE
    samples = {s.name: s for s in all_samples()}
    for case in [*data["cases"], data["baseline"]]:
        sample = samples[case["name"]]
        assert set(case["parsers"]) == {"pdfium", "docling"}
        assert case["sha"] == sample.sha
        assert case["questions"] == len(sample.questions())
        assert case["question"] == sample.questions()[0]["question"]
        for run in case["parsers"].values():
            assert "seconds" not in run
            assert isinstance(run["ms"], int) and run["ms"] >= 0


def test_golds_are_the_single_answer_then_the_list():
    golds = _script().golds
    assert golds({"gold_answer": "A b."}) == ["A b."]
    assert golds({"gold_answer": "| A | 1 |", "gold_answers": ["A 1"]}) == ["| A | 1 |", "A 1"]


def test_the_excerpt_tries_every_gold_passage_in_order():
    first_excerpt = _script().first_excerpt
    filler = " ".join(f"word{i}" for i in range(80))
    text = f"{filler} Readers who lost their place 41 16 -61% {filler}"
    out = first_excerpt(text, ["| Readers who lost their place | 41 | 16 | -61% |", "Readers who lost their place 41 16 -61%"])
    assert out is not None and "Readers who lost their place 41 16" in out
    assert out == out.strip()
    assert first_excerpt(text, ["Nothing like this sentence is here."]) is None


def test_the_query_node_carries_every_gold_passage():
    graph = _script().build_graph("sha", "f.pdf", "pdfium", {}, "q?", ["| A | 1 |", "A 1"])
    ask = next(n for n in graph.nodes if n.id == "ask")
    assert ask.config == {"text": "q?", "gold_answer": "| A | 1 |", "gold_answers": ["| A | 1 |", "A 1"]}


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
    """The stable facts match; the hit counts are only checked for range.

    A hit count depends on where the embedder ranks a passage, and that moves by a
    place or two between Windows and Linux, so an exact count is not a fact about
    the sample. The sample files, the parser text from pdfium and the OCR switch are.
    """
    out = tmp_path / "parsing-lab.json"
    fresh = _script().record(out)
    committed = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert [c["name"] for c in fresh["cases"]] == [c["name"] for c in committed["cases"]]
    assert fresh["baseline"]["name"] == committed["baseline"]["name"]
    for f, c in zip([*fresh["cases"], fresh["baseline"]], [*committed["cases"], committed["baseline"]]):
        assert (f["sha"], f["pages"], f["questions"]) == (c["sha"], c["pages"], c["questions"])
        assert list(f["parsers"]) == list(c["parsers"])
        assert f["parsers"]["pdfium"]["chars"] == c["parsers"]["pdfium"]["chars"]
        for parser in c["parsers"]:
            assert f["parsers"][parser]["ocr"] == c["parsers"][parser]["ocr"]
            assert 0 <= f["parsers"][parser]["hits"] <= f["questions"]
    scanned = next(c for c in [*fresh["cases"], fresh["baseline"]] if c["name"] == "scanned-notes")
    assert scanned["parsers"]["pdfium"]["hits"] == 0, "no text layer, so nothing to find"
    assert json.loads(out.read_text(encoding="utf-8")) == fresh


def test_parse_time_is_whole_milliseconds():
    ms = _script().ms
    assert ms(12.4) == 12
    assert ms(0.2) == 0
    assert ms(2345.6) == 2346


def test_the_warm_up_covers_every_parse_config_on_a_sample_that_is_not_a_case():
    script = _script()
    assert script.WARM_UP not in script.CASES
    configs = {(p, tuple(sorted(script.parse_config(p, c).items()))) for c in script.CASES for p in script.PARSERS}
    warmed = {(p, tuple(sorted(cfg.items()))) for p, cfg in script.WARM_UP_CONFIGS}
    assert configs <= warmed
