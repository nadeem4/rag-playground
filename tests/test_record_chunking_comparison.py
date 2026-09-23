"""The chunking-strategies recording: `scripts/record_chunking_comparison.py`.

The fast half checks the pure parts on small stand-in payloads: the per-strategy
summary and the choice of the side-by-side passage. The slow half, marked
`models`, re-runs the real comparison (Docling and Qwen3) and checks the
committed JSON still has the same structure.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RECORDED = ROOT / "web" / "src" / "learn" / "chunking-strategies.json"


def _script():
    spec = importlib.util.spec_from_file_location(
        "record_chunking_comparison", ROOT / "scripts" / "record_chunking_comparison.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


QUESTIONS = [
    {"id": "one", "question": "First?", "gold_answer": "Because."},
    {"id": "two", "question": "Second?", "gold_answer": "Also because."},
]

CHUNK_PAYLOAD = {
    "chunks": [
        {
            "id": "aaaa", "ordinal": 0, "start_char": 0, "end_char": 10,
            "page_span": [1, 1], "text": "First one.", "token_count": 3,
            "heading_path": ["Title"],
        },
        {
            "id": "bbbb", "ordinal": 1, "start_char": 10, "end_char": 21,
            "page_span": [1, 2], "text": "Second one.", "token_count": 4,
            "heading_path": [],
        },
    ],
    "chunker_meta": {"chunker": "token_based", "max_tokens": 512, "overlap": 64},
}

EVALS = [
    {"hit": True, "rank": 2, "match": "normalized"},
    {"hit": False, "rank": None, "match": "none"},
]


def test_summary_keeps_only_what_the_lesson_draws():
    out = _script().summarize(CHUNK_PAYLOAD, EVALS, QUESTIONS)
    assert out["settings"] == {"max_tokens": 512, "overlap": 64}
    assert out["chunks"] == [
        {"id": "aaaa", "ordinal": 0, "start": 0, "end": 10, "page_span": [1, 1],
         "token_count": 3, "text": "First one."},
        {"id": "bbbb", "ordinal": 1, "start": 10, "end": 21, "page_span": [1, 2],
         "token_count": 4, "text": "Second one."},
    ]
    assert out["evaluation"]["questions"] == [
        {"id": "one", "question": "First?", "hit": True, "rank": 2, "match": "normalized"},
        {"id": "two", "question": "Second?", "hit": False, "rank": None, "match": "none"},
    ]


def test_the_hit_rate_is_the_share_of_questions_answered():
    out = _script().summarize(CHUNK_PAYLOAD, EVALS, QUESTIONS)
    assert out["evaluation"]["hits"] == 1
    assert out["evaluation"]["asked"] == 2
    assert out["evaluation"]["hit_rate"] == 0.5


def _spans(*pairs):
    return [{"start": a, "end": b} for a, b in pairs]


def test_the_passage_is_a_paragraph_all_three_cut_differently():
    paragraphs = [(0, 100), (100, 200)]
    chunks = {
        # Inside the first paragraph two of the three cut in the same place.
        # Inside the second one every strategy cuts somewhere else.
        "a": _spans((0, 100), (100, 200)),
        "b": _spans((0, 50), (50, 100), (100, 120), (120, 200)),
        "c": _spans((0, 50), (50, 100), (100, 150), (150, 200)),
    }
    assert _script().pick_passage(paragraphs, chunks) == {"start": 100, "end": 200}


def test_among_those_the_passage_is_the_one_whose_cuts_differ_most():
    paragraphs = [(0, 100), (100, 200)]
    chunks = {
        # All three differ inside both paragraphs, but they differ by more
        # inside the first one.
        "a": _spans((0, 100), (100, 200)),
        "b": _spans((0, 20), (20, 100), (100, 120), (120, 200)),
        "c": _spans((0, 40), (40, 60), (60, 100), (100, 140), (140, 200)),
    }
    assert _script().pick_passage(paragraphs, chunks) == {"start": 0, "end": 100}


def test_the_graph_is_the_comparison_pipeline():
    g = _script().build_graph("ab" * 32, "chunking-primer.pdf", "markdown_header")
    steps = [(n.stage.value, n.transform, n.config) for n in g.nodes]
    assert steps[1:] == [
        ("parse", "docling", {}),
        ("clean", "dedupe_blocks", {}),
        ("chunk", "markdown_header", {}),
        ("index", "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
        ("query", "text", {"text": "", "gold_answer": ""}),
        ("retrieve", "hybrid_rrf", {}),
        ("use_case", "eval", {}),
    ]


def test_every_strategy_runs_at_its_own_defaults():
    for strategy in _script().STRATEGIES:
        chunk = [n for n in _script().build_graph("ab" * 32, "s.pdf", strategy).nodes
                 if n.id == "chunk"][0]
        assert chunk.config == {}, "a default is what a newcomer gets"


def _shape(value):
    """The structure of a JSON value: keys and types, not the values."""
    if isinstance(value, dict):
        return {k: _shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [_shape(value[0])] if value else []
    if isinstance(value, bool) or value is None:
        return type(value).__name__
    if isinstance(value, (int, float)):
        return "number"
    return type(value).__name__


def test_the_committed_run_has_every_field_the_lesson_reads():
    data = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert set(data) >= {"doc_text", "passage", "index", "strategies", "questions"}
    assert set(data["strategies"]) == set(_script().STRATEGIES)
    assert set(data["index"]) == set(_script().STRATEGIES)
    start, end = data["passage"]["start"], data["passage"]["end"]
    assert 0 <= start < end <= len(data["doc_text"])
    for name, strategy in data["strategies"].items():
        assert strategy["chunks"], name
        assert strategy["evaluation"]["asked"] == len(data["questions"])
        for chunk in strategy["chunks"]:
            assert data["doc_text"][chunk["start"]:chunk["end"]] == chunk["text"]


@pytest.mark.models
def test_a_fresh_run_matches_the_committed_json_in_structure():
    fresh = _script().record()
    committed = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert _shape(fresh) == _shape(committed)
    assert fresh["passage"] == committed["passage"]
    for name, strategy in fresh["strategies"].items():
        was = committed["strategies"][name]
        assert len(strategy["chunks"]) == len(was["chunks"])
        assert strategy["evaluation"]["hit_rate"] == was["evaluation"]["hit_rate"]
