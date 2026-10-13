"""Index two bundled sample PDFs with pandion, then ask them a question.

With no key the answer step is `search`, from pipeline.yaml: it shows the
pieces retrieval found, as they are. It asks twice, and the second time every
step is reused. With ANTHROPIC_API_KEY set it also asks Claude Haiku 4.5 for an
answer that cites those pieces (the `chat` step), which costs one call.

    uv run python examples/pandion/ask_samples.py
    uv run python examples/pandion/ask_samples.py "What does overlap do?"
    uv run python examples/pandion/ask_samples.py --embedder bge-small-en-v1.5
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import yaml

from pandion import Pipeline, QueryPipeline
from pandion.answer import Chat

HERE = Path(__file__).resolve().parent
SAMPLES = HERE.parents[1] / "samples"
FILES = [
    SAMPLES / "chunking-primer" / "chunking-primer.pdf",
    SAMPLES / "two-column-report" / "two-column-report.pdf",
]
QUESTION = "How big should a chunk be?"


def show(title: str, answer) -> None:
    print(f"\n{title}")
    steps = [("rewrite", answer.stages["rewrite"]), ("search", answer.stages["search"])]
    steps += [(f"rerank {n}", step) for n, step in enumerate(answer.stages["rerank"], 1)]
    steps.append(("answer", answer.stages["answer"]))
    for name, step in steps:
        print(f"  {name} ({step.transform}): {step.status}. {step.error or ''}")
    print(answer.text)


def main(
    work: Path,
    question: str = QUESTION,
    api_key: str | None = None,
    embedder: str = "qwen3-embedding-0.6b",
):
    """Index the samples under `work` and ask `question`.

    With no key it asks twice with search and returns both answers. With a
    key it asks once with chat and returns that answer and None.
    """
    config = yaml.safe_load((HERE / "pipeline.yaml").read_text(encoding="utf-8"))
    config["index"]["embed"]["use"] = embedder
    work.mkdir(parents=True, exist_ok=True)
    file = work / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    pipeline = Pipeline.from_yaml(file)
    pipeline.index.run(FILES)
    if api_key:
        # The same index and retrieval, with chat as the answer step instead.
        chat = QueryPipeline(pipeline.retrieval, answer=Chat(model="claude-haiku-4-5"))
        answer = chat.ask(question, credentials={"anthropic_api_key": api_key})
        show(f"Chat answer: {question}", answer)
        return answer, None
    first = pipeline.ask(question)
    show(f"First ask: {question}", first)
    second = pipeline.ask(question)
    print("\nSet ANTHROPIC_API_KEY to ask Claude Haiku 4.5 for an answer that cites these pieces.")
    show("Second ask: every step reused", second)
    return first, second


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", nargs="?", default=QUESTION)
    parser.add_argument("--embedder", default="qwen3-embedding-0.6b")
    parser.add_argument("--work", type=Path, default=Path("pandion-ask-example"))
    args = parser.parse_args()
    main(args.work, args.question, os.environ.get("ANTHROPIC_API_KEY"), args.embedder)
