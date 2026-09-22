"""Record the run the end-to-end lesson shows.

    uv run python scripts/record_e2e_lesson.py

Runs the bundled sample through the real pipeline, in-process, the way
`web/scripts/export_fixtures.py` does: Docling, the duplicate cleaner,
recursive chunks of 400 characters with 80 of overlap, a LanceDB index on
Qwen3, one question, hybrid search, MMR and Search. It writes only what the
lesson draws to `web/src/learn/e2e-run.json`. Every number on the lesson page
is computed from that file.

Needs the Docling and Qwen3 models (downloaded on first use). Everything runs
in a temp directory; nothing is written to `sources/` or the artifact store.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.artifacts import ArtifactType  # noqa: E402
from core.graph import Edge, Graph, Node  # noqa: E402
from core.ports import Stage  # noqa: E402

SAMPLE = ROOT / "samples" / "chunking-primer.pdf"
OUT = ROOT / "web" / "src" / "learn" / "e2e-run.json"
QUESTION = "Why do chunk boundaries matter?"


def build_graph(sha: str, filename: str) -> Graph:
    """The lesson's pipeline. The query reaches retrieval and MMR ambiently."""
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": filename}),
        Node("parse", Stage.PARSE, "docling", {}),
        Node("clean", Stage.CLEAN, "dedupe_blocks", {}),
        Node("chunk", Stage.CHUNK, "recursive_character", {"chunk_size": 400, "chunk_overlap": 80}),
        Node("index", Stage.INDEX, "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
        Node("ask", Stage.QUERY, "text", {"text": QUESTION}),
        Node("retrieve", Stage.RETRIEVE, "hybrid_rrf", {}),
        Node("rerank", Stage.RERANK, "mmr", {}),
        Node("search", Stage.USE_CASE, "search", {}),
    ]
    edges = [
        Edge("src", "parse", "file"),
        Edge("parse", "clean", "doc"),
        Edge("clean", "chunk", "doc"),
        Edge("chunk", "index", "chunks"),
        Edge("index", "retrieve", "index"),
        Edge("retrieve", "rerank", "result"),
        Edge("rerank", "search", "result"),
    ]
    return Graph(nodes=nodes, edges=edges)


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
    import plugins
    from core.executor import run
    from core.registry import registry
    from core.storage import Store
    from plugins.source import upload

    plugins.discover()
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
            store = Store(root / "store")
            result = run(build_graph(sha, SAMPLE.name), registry, store)
            if not result.ok:
                failures = {n: r.error for n, r in result.nodes.items() if r.error}
                raise SystemExit(f"pipeline failed: {failures}")

            def load(nid: str, t: ArtifactType):
                return store.load(result.nodes[nid].artifact.id, t)

            index_dir = Path(load("index", ArtifactType.INDEX))
            payloads = {
                "parse": load("parse", ArtifactType.PARSED_DOC),
                "clean": load("clean", ArtifactType.PARSED_DOC),
                "chunk": load("chunk", ArtifactType.CHUNK_SET),
                "index": json.loads((index_dir / "descriptor.json").read_text(encoding="utf-8")),
                "retrieve": load("retrieve", ArtifactType.RETRIEVAL_RESULT),
                "rerank": load("rerank", ArtifactType.RETRIEVAL_RESULT),
            }
            return summarize(payloads, QUESTION)
        finally:
            upload.SOURCES_DIR = previous


def main() -> None:
    data = record()
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(data['chunks'])} chunks, {len(data['pool'])} in the pool")


if __name__ == "__main__":
    main()
