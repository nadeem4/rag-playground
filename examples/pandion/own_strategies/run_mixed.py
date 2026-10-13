"""Mix your own strategies with built-in ones, in code.

The built-in pdfium parser and recursive_character chunker read notes.pdf (the
three notes in one PDF), and the custom letter_counts embedder, jsonl_store,
jsonl_search and bullets do the rest. Needs the pdfium extra; nothing is
downloaded.

    uv run python examples/pandion/own_strategies/run_mixed.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import my_strategies  # noqa: E402,F401  registers every strategy in the folder

from pandion import Pipeline  # noqa: E402
from pandion.config import to_dict  # noqa: E402

QUESTION = "What causes the tides?"


def main(work: Path) -> int:
    p = Pipeline(
        path=work / "index",
        parse="pdfium",
        chunk={"use": "recursive_character", "chunk_size": 200, "chunk_overlap": 20},
        embed="letter_counts",
        store="jsonl_store",
        search="jsonl_search",
        answer="bullets",
    )
    # No source is set, so the documents are the files given to index.run.
    report = p.index.run(HERE / "notes.pdf")
    if not report.ok:
        print("Indexing failed:", report, file=sys.stderr)
        return 1
    data = to_dict(p.config)
    steps = [data["index"][key]["use"] for key in ("parse", "chunk", "embed", "store")]
    steps += [data["retrieve"]["search"]["use"], data["answer"]["use"]]
    print("strategies used:", ", ".join(steps))

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
