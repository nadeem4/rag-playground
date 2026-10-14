"""Record the run the end-to-end lesson shows.

    uv run python scripts/record_e2e_lesson.py

Runs the bundled sample through the real pipeline, in-process, on Pandion's
public API (`scripts/lesson_runs.py`), the way `playground/frontend/scripts/export_fixtures.py`
does: Docling, the duplicate cleaner, recursive chunks of 400 characters with
80 of overlap, a LanceDB index on Qwen3, one question, hybrid search, MMR and Search. It writes only what the
lesson draws to `playground/frontend/src/learn/e2e-run.json`. Every number on the lesson page
is computed from that file.

Needs the Docling and Qwen3 models (downloaded on first use). Everything runs
in a temp directory; nothing is written to `sources/` or the artifact store.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SAMPLE = ROOT / "samples" / "chunking-primer" / "chunking-primer.pdf"
OUT = ROOT / "playground" / "frontend" / "src" / "learn" / "e2e-run.json"
QUESTION = "Why do chunk boundaries matter?"

PIPELINE = {
    "index": {
        "parse": {"use": "docling"},
        "clean": [{"use": "dedupe_blocks"}],
        "chunk": {"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 80},
        "embed": {"use": "qwen3-embedding-0.6b"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "hybrid_rrf"}, "rerank": [{"use": "mmr"}]},
    "answer": {"use": "search"},
}


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


def summarize(payloads: dict, question: str) -> dict:
    """Keep only what the lesson draws, from each node's real payload."""
    parse = payloads["parse"]
    pages = {e["id"]: e["page"] for e in parse["elements"]}
    texts = {e["id"]: e["text"] for e in parse["elements"]}
    removed = [
        {
            "type": r["type"],
            "page": r["page"],
            "text": texts.get(r["id"], r["preview"]),
            "duplicate_of_page": pages.get(r.get("duplicate_of")),
            "reason": r["reason"],
        }
        for report in payloads["clean"]["parser_meta"].get("clean_report", [])
        for r in report["removed"]
    ]
    index = payloads["index"]
    return {
        "question": question,
        "filename": parse["filename"],
        "page_count": parse["page_count"],
        "chunks": [
            {
                "id": c["id"],
                "ordinal": c["ordinal"],
                "start": c["start_char"],
                "end": c["end_char"],
                "page_span": c["page_span"],
                "text": c["text"],
            }
            for c in payloads["chunk"]["chunks"]
        ],
        "pool": [
            {
                "id": h["chunk"]["id"],
                "rank": h["rank"],
                "score": _round(h["score"], 6),
                "dense": _round(h["component_scores"].get("dense"), 4),
                "bm25": _round(h["component_scores"].get("bm25"), 4),
            }
            for h in payloads["retrieve"]["hits"]
        ],
        "mmr": [h["chunk"]["id"] for h in payloads["rerank"]["hits"]],
        "elements": [{"type": e["type"], "page": e["page"], "text": e["text"]} for e in parse["elements"]],
        "removed": removed,
        "index": {"model": index["embedding_model"], "dim": index["dim"], "doc_count": index["doc_count"]},
        "chunker": payloads["chunk"]["chunker_meta"],
    }


def record() -> dict:
    """Run the real pipeline on the sample and return the lesson's summary."""
    from scripts.lesson_runs import run_pipeline

    with tempfile.TemporaryDirectory() as tmp:
        out = run_pipeline(PIPELINE, SAMPLE, Path(tmp), question=QUESTION)
    payloads = {
        "parse": out["parse"], "clean": out["clean.1"], "chunk": out["chunk"],
        "index": out["index"], "retrieve": out["search"], "rerank": out["rerank.1"],
    }
    return summarize(payloads, QUESTION)


def main() -> None:
    data = record()
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(data['chunks'])} chunks, {len(data['pool'])} in the pool")


if __name__ == "__main__":
    main()
