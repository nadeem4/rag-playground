"""Keep a pandion index in step with a folder as files come and go.

It copies two sample PDFs into a folder and syncs. Then it adds a third sample
and syncs, and removes it again and syncs. Each sync prints what it added,
changed, removed and left unchanged.

    uv run python examples/pandion/sync_samples.py
    uv run python examples/pandion/sync_samples.py --embedder fake-deterministic
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import yaml

from pandion import Pipeline

HERE = Path(__file__).resolve().parent
SAMPLES = HERE.parents[1] / "samples"
START = ["chunking-primer", "two-column-report"]
EXTRA = "table-of-figures"


def show(title: str, report) -> None:
    print(f"\n{title}")
    for what in ("added", "changed", "removed", "unchanged"):
        print(f"  {what}: {', '.join(getattr(report, what)) or 'none'}")


def main(work: Path, embedder: str = "qwen3-embedding-0.6b"):
    """Sync a folder under `work` three times. Returns the three reports."""
    config = yaml.safe_load((HERE / "pipeline.yaml").read_text(encoding="utf-8"))
    config["index"]["embed"]["use"] = embedder
    work.mkdir(parents=True, exist_ok=True)
    file = work / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    docs = work / "docs"
    docs.mkdir(exist_ok=True)
    for name in START:
        shutil.copy(SAMPLES / name / f"{name}.pdf", docs)

    pipeline = Pipeline.from_file(file)
    first = pipeline.index.sync(docs)
    show("First sync", first)

    shutil.copy(SAMPLES / EXTRA / f"{EXTRA}.pdf", docs)
    added = pipeline.index.sync(docs)
    show(f"After adding {EXTRA}.pdf", added)

    (docs / f"{EXTRA}.pdf").unlink()
    removed = pipeline.index.sync(docs)
    show(f"After removing {EXTRA}.pdf", removed)
    return first, added, removed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--embedder", default="qwen3-embedding-0.6b")
    parser.add_argument("--work", type=Path, default=Path("pandion-sync-example"))
    args = parser.parse_args()
    main(args.work, args.embedder)
