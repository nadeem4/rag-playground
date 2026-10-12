"""Index two bundled sample PDFs with pandion, then index them again.

The first run does the work and prints each step's note. The second run finds
every step already stored and reuses it.

    uv run python examples/pandion/index_samples.py
    uv run python examples/pandion/index_samples.py --embedder bge-small-en-v1.5
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


def show(title: str, report) -> None:
    print(f"\n{title}")
    for name, document in report.documents.items():
        for step, result in document.stages.items():
            print(f"  {name} {step}: {result.status}. {result.note or ''}")
    print(f"  index: {report.index.status}. {report.index.note or ''}")


def main(work: Path, embedder: str = "qwen3-embedding-0.6b"):
    """Index the samples twice under `work`. Returns both reports."""
    config = yaml.safe_load((HERE / "pipeline.yaml").read_text(encoding="utf-8"))
    config["index"]["embed"]["use"] = embedder
    work.mkdir(parents=True, exist_ok=True)
    file = work / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    pipeline = Pipeline.from_file(file)
    first = pipeline.index.run(FILES)
    show("First run", first)
    second = pipeline.index.run(FILES)
    reused = [
        s.status == "cached"
        for s in [*(s for d in second.documents.values() for s in d.stages.values()), second.index]
    ]
    show(f"Second run: {sum(reused)} of {len(reused)} steps reused", second)
    return first, second


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--embedder", default="qwen3-embedding-0.6b")
    parser.add_argument("--work", type=Path, default=Path("pandion-example"))
    args = parser.parse_args()
    main(args.work, args.embedder)
