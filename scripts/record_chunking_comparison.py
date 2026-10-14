"""Record the comparison the chunking-strategies lesson shows.

    uv run python scripts/record_chunking_comparison.py

Runs the bundled sample through the real pipeline, in-process, on Pandion's
public API (`scripts/lesson_runs.py`), once per chunking strategy: Docling,
the duplicate cleaner, the strategy at its own defaults, a LanceDB index on
Qwen3, then every question in `samples/chunking-primer/questions.json` through
hybrid search and `pandion.evaluate`. It writes what the lesson draws to
`web/src/learn/chunking-strategies.json`.

Every strategy runs at its defaults, because that is what a newcomer gets. The
parse is shared, so all three cut the same text and the offsets in the file are
all offsets into one `doc_text`.

Needs the Docling and Qwen3 models (downloaded on first use). Everything runs
in a temp directory; nothing is written to `sources/` or the artifact store.
"""

from __future__ import annotations

import json
import sys
import tempfile
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SAMPLE = ROOT / "samples" / "chunking-primer" / "chunking-primer.pdf"
QUESTIONS_FILE = ROOT / "samples" / "chunking-primer" / "questions.json"
OUT = ROOT / "web" / "src" / "learn" / "chunking-strategies.json"

#: The three chunk-stage strategies, each run with an empty config.
STRATEGIES = ("recursive_character", "markdown_header", "token_based")


def pipeline(strategy: str) -> dict:
    """One strategy's pipeline, the strategy at its own defaults."""
    return {
        "index": {
            "parse": {"use": "docling"},
            "clean": [{"use": "dedupe_blocks"}],
            "chunk": {"use": strategy},
            "embed": {"use": "qwen3-embedding-0.6b"},
            "store": {"use": "lancedb"},
        },
        "retrieve": {"search": {"use": "hybrid_rrf"}},
    }


def summarize(chunk_payload: dict, evals: list[dict], questions: list[dict]) -> dict:
    """One strategy's row: the settings it ran with, its chunks and its score."""
    rows = [
        {
            "id": q["id"],
            "question": q["question"],
            "hit": e["hit"],
            "rank": e["rank"],
            "match": e["match"],
        }
        for q, e in zip(questions, evals, strict=True)
    ]
    hits = sum(1 for r in rows if r["hit"])
    return {
        "settings": {
            k: v for k, v in chunk_payload["chunker_meta"].items() if k != "chunker"
        },
        "chunks": [
            {
                "id": c["id"],
                "ordinal": c["ordinal"],
                "start": c["start_char"],
                "end": c["end_char"],
                "page_span": c["page_span"],
                "token_count": c["token_count"],
                "text": c["text"],
            }
            for c in chunk_payload["chunks"]
        ],
        "evaluation": {
            "hits": hits,
            "asked": len(rows),
            "hit_rate": round(hits / len(rows), 3) if rows else 0.0,
            "questions": rows,
        },
    }


def _interior_cuts(span: tuple[int, int], chunks: list[dict]) -> frozenset[int]:
    """The chunk boundaries that fall strictly inside `span`.

    A boundary on the paragraph's own edge is not a cut through it, so only the
    offsets between the two ends count.
    """
    start, end = span
    return frozenset(
        offset
        for chunk in chunks
        for offset in (chunk["start"], chunk["end"])
        if start < offset < end
    )


def pick_passage(
    paragraphs: list[tuple[int, int]], chunks_by_strategy: dict[str, list[dict]]
) -> dict:
    """The paragraph the three strategies cut most differently.

    Chosen from the data, not by eye: for each paragraph, take each strategy's
    set of boundaries inside it, and prefer first the paragraph where the most
    of those three sets differ from each other, then the one where they differ
    by the most boundaries. Ties go to the earliest paragraph.
    """
    best: tuple[tuple[int, int, int], tuple[int, int]] | None = None
    for span in paragraphs:
        cuts = [_interior_cuts(span, c) for c in chunks_by_strategy.values()]
        distinct = len(set(cuts))
        spread = sum(len(a ^ b) for a, b in combinations(cuts, 2))
        key = (distinct, spread, -span[0])
        if best is None or key > best[0]:
            best = (key, span)
    if best is None:
        raise SystemExit("the sample has no paragraphs")
    return {"start": best[1][0], "end": best[1][1]}


def record() -> dict:
    """Run every strategy over every question and return the lesson's summary."""
    from pandion.evaluation import paragraph_spans
    from scripts.lesson_runs import evaluate_pipeline, run_pipeline

    questions = json.loads(QUESTIONS_FILE.read_text(encoding="utf-8"))
    strategies: dict[str, dict] = {}
    index: dict[str, dict] = {}
    chunks_by_strategy: dict[str, list[dict]] = {}
    with tempfile.TemporaryDirectory() as tmp:
        # One root for every run, so the parse and the clean are done once
        # and all three strategies cut exactly the same text.
        root = Path(tmp)
        for strategy in STRATEGIES:
            out = run_pipeline(pipeline(strategy), SAMPLE, root)
            report = evaluate_pipeline(pipeline(strategy), SAMPLE, root, questions)
            failed = {q["id"]: q["error"] for q in report["questions"] if q["error"]}
            if failed:
                raise SystemExit(f"{strategy} failed: {failed}")
            evals = [q["score"] for q in report["questions"]]
            strategies[strategy] = summarize(out["chunk"], evals, questions)
            chunks_by_strategy[strategy] = strategies[strategy]["chunks"]
            index[strategy] = {
                "embedder": out["index"]["embedding_model"],
                "dim": out["index"]["dim"],
                "doc_count": out["index"]["doc_count"],
            }
    return {
        "doc_text": out["chunk"]["source_text"],
        "passage": pick_passage(paragraph_spans(out["clean.1"]), chunks_by_strategy),
        "questions": questions,
        "index": index,
        "strategies": strategies,
    }


def main() -> None:
    data = record()
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    for name, strategy in data["strategies"].items():
        score = strategy["evaluation"]
        lost = [q["id"] for q in score["questions"] if not q["hit"]]
        print(
            f"  {name}: {len(strategy['chunks'])} chunks, "
            f"{score['hits']}/{score['asked']} answered"
            + (f", lost {', '.join(lost)}" if lost else "")
        )


if __name__ == "__main__":
    main()
