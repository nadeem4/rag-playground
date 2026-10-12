"""Turn a question into the query retrieval searches with, as typed or rewritten.

With no key it shows the question as typed (the `text` step). With
ANTHROPIC_API_KEY set it also asks Claude Haiku 4.5 to restate the question in
the words of a sample document (the `llm_rewrite` step), which costs one call.

    uv run python examples/pandion/rewrite_question.py
    uv run python examples/pandion/rewrite_question.py "How long should a piece be?"
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pandion

SAMPLE = (
    Path(__file__).resolve().parents[2] / "samples" / "chunking-primer" / "chunking-primer.pdf"
)


def main(question: str, api_key: str | None = None):
    """Print the query as typed and, given a key, as rewritten. Returns both."""
    typed = pandion.rewrite(question, use="text")
    print(f"As typed: {typed.output.text}")
    if not api_key:
        print("Set ANTHROPIC_API_KEY to see the model's rewrite too.")
        return typed, None
    doc = pandion.parse(SAMPLE, use="pdfium")
    rewritten = pandion.rewrite(
        question,
        use="llm_rewrite",
        model="claude-haiku-4-5",
        style="keywords",
        doc=doc,
        credentials={"anthropic_api_key": api_key},
    )
    print(f"Rewritten: {rewritten.output.text}")
    print(f"The answer still uses: {rewritten.output.asked}")
    return typed, rewritten


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", nargs="?", default="How big should a piece of text be?")
    args = parser.parse_args()
    main(args.question, os.environ.get("ANTHROPIC_API_KEY"))
