"""Build the pipeline in pipeline.yaml three ways, and show they are one pipeline.

The three ways are the YAML file, a dict per stage, and the step classes. All
three keep their files in one folder. The YAML pipeline indexes two samples and
answers a question; the other two then find every step already stored, because
the same settings give the same artifact ids whichever way they are written.

    uv run python examples/pandion/three_styles.py
    uv run python examples/pandion/three_styles.py --embedder bge-small-en-v1.5
"""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml

from pandion import Pipeline
from pandion.answer import Search
from pandion.chunk import RecursiveCharacter
from pandion.clean import DedupeBlocks
from pandion.parse import Pdfium
from pandion.rerank import Mmr
from pandion.retrieve import HybridRrf

HERE = Path(__file__).resolve().parent
SAMPLES = HERE.parents[1] / "samples"
FILES = [
    SAMPLES / "chunking-primer" / "chunking-primer.pdf",
    SAMPLES / "two-column-report" / "two-column-report.pdf",
]
QUESTION = "How big should a chunk be?"


def with_yaml(work: Path, embedder: str) -> Pipeline:
    """The file, with the embedder and the folder changed."""
    config = yaml.safe_load((HERE / "pipeline.yaml").read_text(encoding="utf-8"))
    config["index"]["embed"]["use"] = embedder
    config["path"] = "./index"
    file = work / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return Pipeline.from_yaml(file)


def with_dicts(work: Path, embedder: str) -> Pipeline:
    """Each stage as a dict: the file's block for that stage."""
    return Pipeline(
        path=work / "index",
        parse={"use": "pdfium"},
        clean=[{"use": "dedupe_blocks"}],
        chunk={"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 40},
        embed={"use": embedder},
        store={"use": "lancedb"},
        search={"use": "hybrid_rrf", "top_k": 20},
        rerank=[{"use": "mmr", "top_k": 5}],
        answer={"use": "search", "top_k": 3},
    )


def with_classes(work: Path, embedder: str) -> Pipeline:
    """Each stage as a class; a plain name is short for {"use": name}."""
    return Pipeline(
        path=work / "index",
        parse=Pdfium(),
        clean=[DedupeBlocks()],
        chunk=RecursiveCharacter(chunk_size=400, chunk_overlap=40),
        embed=embedder,
        store="lancedb",
        search=HybridRrf(top_k=20),
        rerank=[Mmr(top_k=5)],
        answer=Search(top_k=3),
    )


def steps(answer) -> list:
    stages = answer.stages
    return [answer.index, stages["rewrite"], stages["search"], *stages["rerank"], stages["answer"]]


def main(work: Path, embedder: str = "qwen3-embedding-0.6b") -> dict:
    """Index and ask with each style in `work`. Returns each style's answer."""
    work.mkdir(parents=True, exist_ok=True)
    runs = {}
    for style, build in (("yaml", with_yaml), ("dicts", with_dicts), ("classes", with_classes)):
        pipeline = build(work, embedder)
        pipeline.index.run(FILES)
        answer = pipeline.ask(QUESTION)
        reused = sum(step.status == "cached" for step in steps(answer))
        print(f"{style}: {reused} of {len(steps(answer))} steps reused, answer id {answer.stages['answer'].artifact_id[:12]}")
        runs[style] = answer
    ids = [[step.artifact_id for step in steps(answer)] for answer in runs.values()]
    if ids[0] == ids[1] == ids[2]:
        print("The artifact ids match in all three.")
    else:
        print("The artifact ids differ, which should never happen.")
    print("\nThe classes pipeline written back as YAML:\n")
    print(with_classes(work, embedder).to_yaml())
    return runs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--embedder", default="qwen3-embedding-0.6b")
    parser.add_argument("--work", type=Path, default=Path("pandion-styles-example"))
    args = parser.parse_args()
    main(args.work, args.embedder)
