"""Record the comparison the chunking-strategies lesson shows.

    uv run python scripts/record_chunking_comparison.py

Runs the bundled sample through the real pipeline, in-process, once per
chunking strategy: Docling, the duplicate cleaner, the strategy at its own
defaults, a LanceDB index on Qwen3, then every question in
`samples/questions.json` through hybrid search and the evaluation step. It
writes what the lesson draws to `web/src/learn/chunking-strategies.json`.

Every strategy runs at its defaults, because that is what a newcomer gets. The
parse is shared, so all three cut the same text and the offsets in the file are
all offsets into one `doc_text`.

Needs the Docling and Qwen3 models (downloaded on first use). Everything runs
in a temp directory; nothing is written to `sources/` or the artifact store.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.artifacts import ArtifactType  # noqa: E402
from core.graph import Edge, Graph, Node  # noqa: E402
from core.ports import Stage  # noqa: E402

SAMPLE = ROOT / "samples" / "chunking-primer.pdf"
QUESTIONS_FILE = ROOT / "samples" / "questions.json"
OUT = ROOT / "web" / "src" / "learn" / "chunking-strategies.json"

#: The three chunk-stage strategies, each run with an empty config.
STRATEGIES = ("recursive_character", "markdown_header", "token_based")


def build_graph(sha: str, filename: str, strategy: str) -> Graph:
    """One strategy's pipeline. The question reaches retrieval and eval ambiently."""
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": filename}),
        Node("parse", Stage.PARSE, "docling", {}),
        Node("clean", Stage.CLEAN, "dedupe_blocks", {}),
        Node("chunk", Stage.CHUNK, strategy, {}),
        Node("index", Stage.INDEX, "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
        Node("ask", Stage.QUERY, "text", {"text": "", "gold_answer": ""}),
        Node("retrieve", Stage.RETRIEVE, "hybrid_rrf", {}),
        Node("score", Stage.USE_CASE, "eval", {}),
    ]
    edges = [
        Edge("src", "parse", "file"),
        Edge("parse", "clean", "doc"),
        Edge("clean", "chunk", "doc"),
        Edge("chunk", "index", "chunks"),
        Edge("index", "retrieve", "index"),
        Edge("retrieve", "score", "result"),
    ]
    return Graph(nodes=nodes, edges=edges)


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
    import plugins
    from core.executor import run
    from core.registry import registry
    from core.storage import Store
    from plugins.chunk import DocView
    from plugins.source import upload

    plugins.discover()
    questions = json.loads(QUESTIONS_FILE.read_text(encoding="utf-8"))
    pdf = SAMPLE.read_bytes()
    sha = hashlib.sha256(pdf).hexdigest()

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sources = root / "sources"
        sources.mkdir()
        (sources / f"{sha}.pdf").write_bytes(pdf)
        previous = upload.SOURCES_DIR
        upload.SOURCES_DIR = sources
        try:
            # One store for every run, so the parse and the clean are done once
            # and all three strategies cut exactly the same text.
            store = Store(root / "store")
            strategies: dict[str, dict] = {}
            index: dict[str, dict] = {}
            chunks_by_strategy: dict[str, list[dict]] = {}
            doc_text = ""
            clean_payload: dict | None = None

            for strategy in STRATEGIES:
                graph = build_graph(sha, SAMPLE.name, strategy)
                chunk_payload: dict | None = None
                descriptor: dict | None = None
                evals: list[dict] = []
                for question in questions:
                    result = run(
                        graph,
                        registry,
                        store,
                        overrides={
                            "ask": {
                                "text": question["question"],
                                "gold_answer": question["gold_answer"],
                            }
                        },
                    )
                    if not result.ok:
                        failures = {
                            n: r.error for n, r in result.nodes.items() if r.error
                        }
                        raise SystemExit(f"{strategy} failed: {failures}")

                    def load(nid: str, t: ArtifactType, res=result):
                        return store.load(res.nodes[nid].artifact.id, t)

                    if chunk_payload is None:
                        clean_payload = load("clean", ArtifactType.PARSED_DOC)
                        chunk_payload = load("chunk", ArtifactType.CHUNK_SET)
                        doc_text = chunk_payload["source_text"]
                        index_dir = Path(load("index", ArtifactType.INDEX))
                        descriptor = json.loads(
                            (index_dir / "descriptor.json").read_text(encoding="utf-8")
                        )
                    evals.append(load("score", ArtifactType.OUTPUT)["payload"])

                assert chunk_payload is not None and descriptor is not None
                strategies[strategy] = summarize(chunk_payload, evals, questions)
                chunks_by_strategy[strategy] = strategies[strategy]["chunks"]
                index[strategy] = {
                    "embedder": descriptor["embedding_model"],
                    "dim": descriptor["dim"],
                    "doc_count": descriptor["doc_count"],
                }

            view = DocView.of(clean_payload)
            paragraphs = [
                (e.md_start, e.md_end) for e in view.rendered if e.type == "paragraph"
            ]
            return {
                "doc_text": doc_text,
                "passage": pick_passage(paragraphs, chunks_by_strategy),
                "questions": questions,
                "index": index,
                "strategies": strategies,
            }
        finally:
            upload.SOURCES_DIR = previous


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
