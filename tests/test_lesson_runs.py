"""scripts/lesson_runs.py runs a pipeline the public way and hands back each step's result."""

from pathlib import Path

from scripts.lesson_runs import evaluate_pipeline, run_pipeline

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "samples" / "chunking-primer" / "chunking-primer.pdf"
FAST = {
    "path": ".",
    "index": {
        "parse": {"use": "pdfium"},
        "clean": [{"use": "dedupe_blocks"}],
        "chunk": {"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 80},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "hybrid_rrf"}, "rerank": [{"use": "mmr"}]},
    "answer": {"use": "search"},
}


def test_every_step_comes_back_by_its_name(tmp_path):
    out = run_pipeline(FAST, PDF, tmp_path, question="Why do chunk boundaries matter?")
    assert {"parse", "clean.1", "chunk", "index", "search", "rerank.1", "answer"} <= set(out)
    assert out["parse"]["filename"] == PDF.name
    assert out["chunk"]["chunks"] and out["search"]["hits"]
    assert out["index"]["doc_count"] >= 1
    assert out["duration_ms"]["parse"] is not None


def test_without_a_question_only_the_index_runs(tmp_path):
    out = run_pipeline(FAST, PDF, tmp_path)
    assert "search" not in out and "chunk" in out


def test_an_evaluation_is_pandions_report(tmp_path):
    questions = [{"id": "q", "question": "Why do chunk boundaries matter?", "gold_answers": ["chunk"]}]
    report = evaluate_pipeline(FAST, PDF, tmp_path, questions)
    assert report["total"] == 1 and report["questions"][0]["id"] == "q"
