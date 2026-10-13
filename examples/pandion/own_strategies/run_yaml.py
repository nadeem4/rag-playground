"""Run pipeline.yaml, where every stage uses a strategy from my_strategies/.

Indexes the three notes, prints the strategy of every step, then asks a
question and prints the answer. Nothing is downloaded. The index goes where
the file's `path` says: work/ next to it.

    uv run python examples/pandion/own_strategies/run_yaml.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from pandion import Pipeline
from pandion.config import to_dict

HERE = Path(__file__).resolve().parent

QUESTION = "What causes the tides?"


def strategies(p: Pipeline) -> list[str]:
    """The `use` of every step, in the order the pipeline runs them."""
    data = to_dict(p.config)
    names = []
    for section in (data["index"], data.get("retrieve", {})):
        for step in section.values():
            names += [s["use"] for s in step] if isinstance(step, list) else [step["use"]]
    names.append(data["answer"]["use"])
    return names


def main() -> int:
    # `plugins: [my_strategies]` is imported from the folder the file is in,
    # so the strategies are registered before the steps are checked.
    p = Pipeline.from_yaml(HERE / "pipeline.yaml")

    # With a source other than upload, each item is one document, and the
    # source is told it as `location`.
    report = p.index.run(sorted(str(note) for note in (HERE / "notes").glob("*.md")))
    if not report.ok:
        print("Indexing failed:", report, file=sys.stderr)
        return 1
    print("strategies used:", ", ".join(strategies(p)))

    answer = p.ask(QUESTION)
    if not answer.ok:
        print("Asking failed:", answer, file=sys.stderr)
        return 1
    print(f"\n{QUESTION}\n{answer.text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
