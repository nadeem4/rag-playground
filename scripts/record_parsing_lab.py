"""Record what two parsers do on the bundled samples, for the parsing lab.

    uv run python scripts/record_parsing_lab.py

For each of three samples and each of pdfium and Docling, runs the real
pipeline in-process on Pandion's public API (`scripts/lesson_runs.py`), the
way `scripts/record_e2e_lesson.py` does: parse, recursive chunks of 400
characters with 80 of overlap, a LanceDB index on Qwen3, then every question in
the sample's `questions.json` through hybrid search and `pandion.evaluate`
with top_k 5. It writes only what the lab shows to
`web/src/learn/parsing-lab.json`. The chunking primer is recorded the same
way as a baseline: one column of prose, where the two parsers should agree.

Parse, chunk and index are cached by recipe, so they run once per sample and
parser; only the search and the scoring run per question. The parse time is
the parse step's own duration on its first run, in whole milliseconds. The
warm-up runs in a folder of its own, so the baseline's parse is not a cache hit.

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


def pipeline(parser: str, parse_cfg: dict) -> dict:
    """One sample's pipeline with one parser."""
    return {
        "index": {
            "parse": {"use": parser, **parse_cfg},
            "chunk": {"use": CHUNKER["chunker"], **{k: v for k, v in CHUNKER.items() if k != "chunker"}},
            "embed": {"use": "qwen3-embedding-0.6b"},
            "store": {"use": "lancedb"},
        },
        "retrieve": {"search": {"use": "hybrid_rrf"}},
    }


def question_set(questions: list[dict]) -> list[dict]:
    """The questions as `pandion.evaluate` takes them, each with every gold
    passage, the way the Evaluate page's `questionVariants` does, so a table
    row may be found in either form."""
    return [
        {"id": str(n), "question": q["question"], "gold_answers": golds(q)}
        for n, q in enumerate(questions, start=1)
    ]


def ms(duration_ms: float) -> int:
    """Parse time in whole milliseconds."""
    return round(duration_ms)


def warm_up(pdf: Path, root: Path) -> None:
    """Index the warm-up sample once with every configuration; discard the results."""
    from scripts.lesson_runs import run_pipeline

    for parser, cfg in WARM_UP_CONFIGS:
        run_pipeline(pipeline(parser, cfg), pdf, root)


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


def _measure(sample, parser: str, root: Path) -> dict:
    from pandion.evaluation import document_text
    from scripts.lesson_runs import evaluate_pipeline, run_pipeline

    cfg = parse_config(parser, sample.name)
    questions = sample.questions()
    out = run_pipeline(pipeline(parser, cfg), sample.pdf, root)
    text = document_text(out["parse"])
    report = evaluate_pipeline(pipeline(parser, cfg), sample.pdf, root, question_set(questions))
    failed = {q["id"]: q["error"] for q in report["questions"] if q["error"]}
    if failed:
        raise SystemExit(f"{sample.name}/{parser} failed: {failed}")
    return {
        "ms": ms(out["duration_ms"]["parse"]),
        "chars": len(text),
        "hits": report["found"],
        "ocr": bool(cfg.get("do_ocr", False)),
        "excerpt": first_excerpt(text, golds(questions[0])),
    }


def record(out: Path = OUT) -> dict:
    """Run every case through both parsers and write the lab's JSON to `out`."""
    from api.sample_set import all_samples

    samples = {s.name: s for s in all_samples()}

    def measured(sample, root: Path) -> dict:
        questions = sample.questions()
        parsers = {}
        for parser in PARSERS:
            parsers[parser] = _measure(sample, parser, root)
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
        warm_up(samples[WARM_UP].pdf, Path(tmp) / "warm-up")
        root = Path(tmp) / "runs"
        cases = [measured(samples[name], root) for name in CASES]
        baseline = measured(samples[BASELINE], root)
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
