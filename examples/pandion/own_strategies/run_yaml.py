"""Run pipeline.yaml, where every stage uses a strategy from my_strategies/.

Indexes the three notes, prints the strategy of every step, then asks a
question and prints the answer. Nothing is downloaded.

    uv run python examples/pandion/own_strategies/run_yaml.py
    uv run python examples/pandion/own_strategies/run_yaml.py --work D:/scratch/own
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from pandion import Pipeline
from pandion.config import to_dict

HERE = Path(__file__).resolve().parent
# So that `plugins: [my_strategies]` can import the folder next to this script.
sys.path.insert(0, str(HERE))

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


def main(work: Path) -> int:
    # The same file, with `path` pointing into the work folder.
    config = yaml.safe_load((HERE / "pipeline.yaml").read_text(encoding="utf-8"))
    config["path"] = str(work / "index")
    work.mkdir(parents=True, exist_ok=True)
    (work / "pipeline.yaml").write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    p = Pipeline.from_yaml(work / "pipeline.yaml")

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
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, default=HERE / "work", help="where the index and sources go")
    sys.exit(main(parser.parse_args().work.resolve()))
