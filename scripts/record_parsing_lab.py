"""Record what two parsers do on the bundled samples, for the parsing lab.

    uv run python scripts/record_parsing_lab.py

For each of three samples and each of pdfium and Docling, runs the real
pipeline in-process, the way `scripts/record_e2e_lesson.py` does: parse,
recursive chunks of 400 characters with 80 of overlap, a LanceDB index on
Qwen3, then every question in the sample's `questions.json` through hybrid
search and the eval step with top_k 5. It writes only what the lab shows to
`web/src/learn/parsing-lab.json`. The chunking primer is recorded the same
way as a baseline: one column of prose, where the two parsers should agree.

Parse, chunk and index are cached by recipe, so they run once per sample and
parser; only the question, retrieval and eval run per question. The parse
time is the parse step's own duration on the first run, in whole milliseconds.
The warm-up runs in a store of its own, so the baseline's parse is not a cache hit.

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
#: Recorded like a case, but not a puzzle step: the lesson's point of comparison.
BASELINE = "chunking-primer"
CHUNKER = {"chunker": "recursive_character", "chunk_size": 400, "chunk_overlap": 80}
TOP_K = 5
WINDOW = 160
#: Parsed once per configuration before any timing, so a case's parse time is
#: not its models loading. Not one of the cases, and parsed into a store that is
#: thrown away, so every recorded parse really runs.
WARM_UP = "chunking-primer"
WARM_UP_CONFIGS = [("pdfium", {}), ("docling", {}), ("docling", {"do_ocr": True})]


def parse_config(parser: str, case: str) -> dict:
    if parser == "docling" and case in OCR_CASES:
        return {"do_ocr": True}
    return {}


def golds(question: dict) -> list[str]:
    """Every gold passage of a question: `gold_answer` first, then `gold_answers`, no repeats."""
    out: list[str] = []
    for gold in (question.get("gold_answer", ""), *question.get("gold_answers", [])):
        gold = gold.strip()
        if gold and gold not in out:
            out.append(gold)
    return out


def build_graph(sha: str, filename: str, parser: str, parse_cfg: dict, question: str, gold: list[str]) -> Graph:
    """One sample, one parser, one question. The query reaches retrieval and eval ambiently.

    The query node carries every gold passage, the way the Evaluate page's
    `questionVariants` does, so a table row may be found in either form.
    """
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": filename}),
        Node("parse", Stage.PARSE, parser, parse_cfg),
        Node("chunk", Stage.CHUNK, CHUNKER["chunker"], {k: v for k, v in CHUNKER.items() if k != "chunker"}),
        Node("index", Stage.INDEX, "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
        Node("ask", Stage.QUERY, "text", {"text": question, "gold_answer": gold[0], "gold_answers": gold}),
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


def ms(duration_ms: float) -> int:
    """Parse time in whole milliseconds."""
    return round(duration_ms)


def warm_up(sample, store, registry, run) -> None:
    """Parse the warm-up sample once with every configuration; discard the results."""
    for parser, cfg in WARM_UP_CONFIGS:
        graph = Graph(
            nodes=[
                Node("src", Stage.SOURCE, "upload", {"sha": sample.sha, "filename": sample.pdf.name}),
                Node("parse", Stage.PARSE, parser, cfg),
            ],
            edges=[Edge("src", "parse", "file")],
        )
        result = run(graph, registry, store)
        if not result.ok:
            failures = {nid: r.error for nid, r in result.nodes.items() if r.error}
            raise SystemExit(f"warm-up {parser} {cfg} failed: {failures}")


def excerpt(text: str, gold: str) -> str | None:
    """Up to 160 characters of `text` around the first five words of `gold`, trimmed.

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
    return flat[start : start + WINDOW].strip()


def first_excerpt(text: str, passages: list[str]) -> str | None:
    """The excerpt around the first of `passages` whose first five words are in `text`."""
    for passage in passages:
        found = excerpt(text, passage)
        if found is not None:
            return found
    return None


def _measure(sample, parser: str, store, registry, run) -> dict:
    from plugins.chunk import DocView

    cfg = parse_config(parser, sample.name)
    questions = sample.questions()
    entry: dict = {}
    hits = 0
    for n, q in enumerate(questions):
        graph = build_graph(sample.sha, sample.pdf.name, parser, cfg, q["question"], golds(q))
        result = run(graph, registry, store)
        if not result.ok:
            failures = {nid: r.error for nid, r in result.nodes.items() if r.error}
            raise SystemExit(f"{sample.name}/{parser} failed: {failures}")
        if n == 0:
            parse = result.nodes["parse"]
            doc = store.load(parse.artifact.id, ArtifactType.PARSED_DOC)
            text = DocView.of(doc).text
            entry["ms"] = ms(parse.duration_ms)
            entry["chars"] = len(text)
        output = store.load(result.nodes["eval"].artifact.id, ArtifactType.OUTPUT)
        hits += bool(output["payload"]["hit"])
    entry["hits"] = hits
    entry["ocr"] = bool(cfg.get("do_ocr", False))
    entry["excerpt"] = first_excerpt(text, golds(questions[0]))
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
    def measured(sample) -> dict:
        (sources / f"{sample.sha}.pdf").write_bytes(sample.pdf.read_bytes())
        questions = sample.questions()
        parsers = {}
        for parser in PARSERS:
            parsers[parser] = _measure(sample, parser, store, registry, run)
            print(f"{sample.name} / {parser}: {parsers[parser]}", flush=True)
        return {
            "name": sample.name,
            "title": sample.title,
            "sha": sample.sha,
            "filename": sample.pdf.name,
            "pages": sample.pages,
            "questions": len(questions),
            "question": questions[0]["question"],
            "parsers": parsers,
        }

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sources = root / "sources"
        sources.mkdir()
        previous = upload.SOURCES_DIR
        upload.SOURCES_DIR = sources
        try:
            warm = samples[WARM_UP]
            (sources / f"{warm.sha}.pdf").write_bytes(warm.pdf.read_bytes())
            warm_up(warm, Store(root / "warm-up"), registry, run)
            store = Store(root / "store")
            cases = [measured(samples[name]) for name in CASES]
            baseline = measured(samples[BASELINE])
        finally:
            upload.SOURCES_DIR = previous
    data = {
        "recorded_on": datetime.date.today().isoformat(),
        "chunker": CHUNKER,
        "top_k": TOP_K,
        "cases": cases,
        "baseline": baseline,
    }
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return data


def main() -> None:
    record()
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
