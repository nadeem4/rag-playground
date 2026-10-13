"""Index two bundled sample PDFs with pandion, then search them, twice.

It prints what each retrieval step did and the hits, best first. The second
search finds every step already stored and reuses it.

    uv run python examples/pandion/search_samples.py
    uv run python examples/pandion/search_samples.py "What does overlap do?"
    uv run python examples/pandion/search_samples.py --embedder bge-small-en-v1.5
"""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml

from pandion import Pipeline

HERE = Path(__file__).resolve().parent
SAMPLES = HERE.parents[1] / "samples"
FILES = [
    SAMPLES / "chunking-primer" / "chunking-primer.pdf",
    SAMPLES / "two-column-report" / "two-column-report.pdf",
]
QUESTION = "How big should a chunk be?"


def show(title: str, result) -> None:
    print(f"\n{title}")
    steps = [("rewrite", result.stages["rewrite"]), ("search", result.stages["search"])]
    steps += [(f"rerank {n}", step) for n, step in enumerate(result.stages["rerank"], 1)]
    for name, step in steps:
        print(f"  {name} ({step.transform}): {step.status}. {step.note or ''}")
    for hit in result.hits:
        text = " ".join(hit.chunk.text.split())[:80]
        print(f"  {hit.rank}. {hit.score:.3f} {text}")


def main(work: Path, question: str = QUESTION, embedder: str = "qwen3-embedding-0.6b"):
    """Index the samples under `work`, then search them twice. Returns both results."""
    config = yaml.safe_load((HERE / "pipeline.yaml").read_text(encoding="utf-8"))
    config["index"]["embed"]["use"] = embedder
    work.mkdir(parents=True, exist_ok=True)
    file = work / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    pipeline = Pipeline.from_file(file)
    pipeline.index.run(FILES)
    first = pipeline.retrieve(question)
    show(f"First search: {question}", first)
    second = pipeline.retrieve(question)
    steps = [second.stages["rewrite"], second.stages["search"], *second.stages["rerank"]]
    reused = sum(s.status == "cached" for s in steps)
    show(f"Second search: {reused} of {len(steps)} steps reused", second)
    return first, second


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", nargs="?", default=QUESTION)
    parser.add_argument("--embedder", default="qwen3-embedding-0.6b")
    parser.add_argument("--work", type=Path, default=Path("pandion-search-example"))
    args = parser.parse_args()
    main(args.work, args.question, args.embedder)
