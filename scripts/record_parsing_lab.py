"""Record what two parsers do on the bundled samples, for the parsing lab.

    uv run python scripts/record_parsing_lab.py

For each of three samples and each of pdfium and Docling, runs the real
pipeline in-process, the way `scripts/record_e2e_lesson.py` does: parse,
recursive chunks of 400 characters with 80 of overlap, a LanceDB index on
Qwen3, then every question in the sample's `questions.json` through hybrid
search and the eval step with top_k 5. It writes only what the lab shows to
`web/src/learn/parsing-lab.json`.

Parse, chunk and index are cached by recipe, so they run once per sample and
parser; only the question, retrieval and eval run per question. The parse
time is the parse step's own duration on the first run.

Needs the Docling, RapidOCR and Qwen3 models (downloaded on first use).
Everything runs in a temp directory; nothing is written to `sources/` or the
artifact store.
"""

from __future__ import annotations

import datetime
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.artifacts import ArtifactType  # noqa: E402
from core.graph import Edge, Graph, Node  # noqa: E402
from core.ports import Stage  # noqa: E402

OUT = ROOT / "web" / "src" / "learn" / "parsing-lab.json"
CASES = ["two-column-report", "table-of-figures", "scanned-notes"]
PARSERS = ["pdfium", "docling"]
#: Only the scanned sample needs OCR; it is much slower everywhere else.
OCR_CASES = {"scanned-notes"}
CHUNKER = {"chunker": "recursive_character", "chunk_size": 400, "chunk_overlap": 80}
TOP_K = 5
WINDOW = 160


def parse_config(parser: str, case: str) -> dict:
    if parser == "docling" and case in OCR_CASES:
        return {"do_ocr": True}
    return {}


def build_graph(sha: str, filename: str, parser: str, parse_cfg: dict, question: str, gold: str) -> Graph:
    """One sample, one parser, one question. The query reaches retrieval and eval ambiently."""
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": filename}),
        Node("parse", Stage.PARSE, parser, parse_cfg),
        Node("chunk", Stage.CHUNK, CHUNKER["chunker"], {k: v for k, v in CHUNKER.items() if k != "chunker"}),
        Node("index", Stage.INDEX, "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
        Node("ask", Stage.QUERY, "text", {"text": question, "gold_answer": gold}),
        Node("retrieve", Stage.RETRIEVE, "hybrid_rrf", {}),
        Node("eval", Stage.USE_CASE, "eval", {"top_k": TOP_K}),
    ]
    edges = [
        Edge("src", "parse", "file"),
        Edge("parse", "chunk", "doc"),
        Edge("chunk", "index", "chunks"),
        Edge("index", "retrieve", "index"),
        Edge("retrieve", "eval", "result"),
    ]
    return Graph(nodes=nodes, edges=edges)


def excerpt(text: str, gold: str) -> str | None:
    """Up to 160 characters of `text` around the first five words of `gold`.

    Whitespace is collapsed and case ignored when looking; None when the
    words are not there.
    """
    flat = " ".join(text.split())
    words = " ".join(gold.split()[:5]).casefold()
    if not words:
        return None
    at = flat.casefold().find(words)
    if at < 0:
        return None
    centre = at + len(words) // 2
    start = max(0, min(centre - WINDOW // 2, len(flat) - WINDOW))
    return flat[start : start + WINDOW]


def _measure(sample, parser: str, store, registry, run) -> dict:
    from plugins.chunk import DocView

    cfg = parse_config(parser, sample.name)
    questions = sample.questions()
    entry: dict = {}
    hits = 0
    for n, q in enumerate(questions):
        graph = build_graph(sample.sha, sample.pdf.name, parser, cfg, q["question"], q["gold_answer"])
        result = run(graph, registry, store)
        if not result.ok:
            failures = {nid: r.error for nid, r in result.nodes.items() if r.error}
            raise SystemExit(f"{sample.name}/{parser} failed: {failures}")
        if n == 0:
            parse = result.nodes["parse"]
            doc = store.load(parse.artifact.id, ArtifactType.PARSED_DOC)
            text = DocView.of(doc).text
            entry["seconds"] = round(parse.duration_ms / 1000, 1)
            entry["chars"] = len(text)
        output = store.load(result.nodes["eval"].artifact.id, ArtifactType.OUTPUT)
        hits += bool(output["payload"]["hit"])
    entry["hits"] = hits
    entry["ocr"] = bool(cfg.get("do_ocr", False))
    entry["excerpt"] = excerpt(text, questions[0]["gold_answer"])
    return entry


def record(out: Path = OUT) -> dict:
    """Run every case through both parsers and write the lab's JSON to `out`."""
    import plugins
    from api.sample_set import all_samples
    from core.executor import run
    from core.registry import registry
    from core.storage import Store
    from plugins.source import upload

    plugins.discover()
    samples = {s.name: s for s in all_samples()}
    cases = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sources = root / "sources"
        sources.mkdir()
        previous = upload.SOURCES_DIR
        upload.SOURCES_DIR = sources
        try:
            store = Store(root / "store")
            for name in CASES:
                sample = samples[name]
                (sources / f"{sample.sha}.pdf").write_bytes(sample.pdf.read_bytes())
                questions = sample.questions()
                parsers = {}
                for parser in PARSERS:
                    parsers[parser] = _measure(sample, parser, store, registry, run)
                    print(f"{name} / {parser}: {parsers[parser]}", flush=True)
                cases.append(
                    {
                        "name": sample.name,
                        "title": sample.title,
                        "sha": sample.sha,
                        "filename": sample.pdf.name,
                        "pages": sample.pages,
                        "questions": len(questions),
                        "question": questions[0]["question"],
                        "parsers": parsers,
                    }
                )
        finally:
            upload.SOURCES_DIR = previous
    data = {
        "recorded_on": datetime.date.today().isoformat(),
        "chunker": CHUNKER,
        "top_k": TOP_K,
        "cases": cases,
    }
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return data


def main() -> None:
    record()
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
