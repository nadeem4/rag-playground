"""The end-to-end lesson's recorded run: `scripts/record_e2e_lesson.py`.

The fast half checks the pure summary on small stand-in payloads. The slow half,
marked `models`, re-runs the real pipeline (Docling and Qwen3) and checks the
committed JSON still has the same structure.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RECORDED = ROOT / "web" / "src" / "learn" / "e2e-run.json"


def _script():
    spec = importlib.util.spec_from_file_location(
        "record_e2e_lesson", ROOT / "scripts" / "record_e2e_lesson.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _chunk(cid: str, ordinal: int, start: int, end: int, text: str, pages=(1, 1)) -> dict:
    return {
        "id": cid, "ordinal": ordinal, "start_char": start, "end_char": end,
        "page_span": list(pages), "text": text, "heading_path": [], "token_count": 3,
    }


def _hit(chunk: dict, rank: int, score: float, dense: float | None, bm25: float | None) -> dict:
    return {
        "chunk": chunk, "rank": rank, "score": score,
        "component_scores": {"dense": dense, "bm25": bm25},
    }


A = _chunk("aaaa", 0, 0, 10, "First.")
B = _chunk("bbbb", 1, 12, 30, "Second.", (1, 2))
C = _chunk("cccc", 2, 32, 40, "Third.", (2, 2))

PAYLOADS = {
    "parse": {
        "page_count": 2,
        "filename": "sample.pdf",
        "elements": [
            {"id": "e0", "type": "heading", "page": 1, "text": "Title", "order": 0},
            {"id": "e1", "type": "paragraph", "page": 1, "text": "Body.", "order": 1},
            {"id": "e2", "type": "paragraph", "page": 2, "text": "Body.", "order": 2},
        ],
    },
    "clean": {
        "parser_meta": {
            "clean_report": [
                {
                    "cleaner": "dedupe_blocks",
                    "removed": [
                        {"id": "e2", "type": "paragraph", "page": 2, "order": 2,
                         "preview": "Body.", "duplicate_of": "e1", "reason": "exact duplicate of 'e1'"}
                    ],
                }
            ]
        }
    },
    "chunk": {
        "chunks": [A, B, C],
        "chunker_meta": {"chunker": "recursive_character", "chunk_size": 400, "chunk_overlap": 80},
    },
    "index": {"embedding_model": "qwen3-embedding-0.6b", "dim": 1024, "doc_count": 3},
    "retrieve": {"hits": [_hit(B, 1, 0.03, 0.7, 6.2), _hit(A, 2, 0.02, 0.6, None), _hit(C, 3, 0.01, None, 1.5)]},
    "rerank": {"hits": [_hit(B, 1, 0.9, None, None), _hit(C, 2, 0.5, None, None)]},
}


def test_summary_keeps_only_what_the_lesson_draws():
    out = _script().summarize(PAYLOADS, question="Why?")
    assert out["question"] == "Why?"
    assert out["filename"] == "sample.pdf"
    assert out["page_count"] == 2
    assert out["chunks"] == [
        {"id": "aaaa", "ordinal": 0, "start": 0, "end": 10, "page_span": [1, 1], "text": "First."},
        {"id": "bbbb", "ordinal": 1, "start": 12, "end": 30, "page_span": [1, 2], "text": "Second."},
        {"id": "cccc", "ordinal": 2, "start": 32, "end": 40, "page_span": [2, 2], "text": "Third."},
    ]
    assert out["pool"] == [
        {"id": "bbbb", "rank": 1, "score": 0.03, "dense": 0.7, "bm25": 6.2},
        {"id": "aaaa", "rank": 2, "score": 0.02, "dense": 0.6, "bm25": None},
        {"id": "cccc", "rank": 3, "score": 0.01, "dense": None, "bm25": 1.5},
    ]
    assert out["mmr"] == ["bbbb", "cccc"]
    assert out["elements"] == [
        {"type": "heading", "page": 1, "text": "Title"},
        {"type": "paragraph", "page": 1, "text": "Body."},
        {"type": "paragraph", "page": 2, "text": "Body."},
    ]
    assert out["removed"] == [
        {"type": "paragraph", "page": 2, "text": "Body.", "duplicate_of_page": 1, "reason": "exact duplicate of 'e1'"}
    ]
    assert out["index"] == {"model": "qwen3-embedding-0.6b", "dim": 1024, "doc_count": 3}
    assert out["chunker"] == {"chunker": "recursive_character", "chunk_size": 400, "chunk_overlap": 80}


def test_summary_rounds_scores_so_a_rerun_diffs_cleanly():
    payloads = json.loads(json.dumps(PAYLOADS))
    payloads["retrieve"]["hits"][0]["component_scores"]["dense"] = 0.695494353771
    payloads["retrieve"]["hits"][0]["score"] = 0.0327868852459
    out = _script().summarize(payloads, question="Why?")
    assert out["pool"][0]["dense"] == 0.6955
    assert out["pool"][0]["score"] == 0.032787


def test_the_graph_is_the_lesson_pipeline():
    g = _script().build_graph("ab" * 32, "chunking-primer.pdf")
    steps = [(n.stage.value, n.transform, n.config) for n in g.nodes]
    assert steps[1:] == [
        ("parse", "docling", {}),
        ("clean", "dedupe_blocks", {}),
        ("chunk", "recursive_character", {"chunk_size": 400, "chunk_overlap": 80}),
        ("index", "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
        ("query", "text", {"text": "Why do chunk boundaries matter?"}),
        ("retrieve", "hybrid_rrf", {}),
        ("rerank", "mmr", {}),
        ("use_case", "search", {}),
    ]


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
    assert set(data) >= {"question", "filename", "page_count", "chunks", "pool", "mmr", "elements", "removed", "index", "chunker"}
    ids = {c["id"] for c in data["chunks"]}
    assert set(data["mmr"]) <= ids
    assert {p["id"] for p in data["pool"]} <= ids
    assert data["removed"], "the sample has a repeated paragraph for the cleaner to remove"


@pytest.mark.models
def test_a_fresh_run_matches_the_committed_json_in_structure():
    fresh = _script().record()
    committed = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert _shape(fresh) == _shape(committed)
    assert len(fresh["chunks"]) == len(committed["chunks"])
    assert len(fresh["pool"]) == len(committed["pool"])
    assert fresh["mmr"] == committed["mmr"]
