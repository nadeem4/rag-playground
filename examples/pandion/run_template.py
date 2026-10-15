"""Run an index template and a query template together with Pandion.

The templates ship with Pandion (`pandion.list_templates`): an index template sets how a
document is read and indexed, a query template how it is searched and
answered. This script joins one of each into a pipeline, indexes a PDF with
it and asks one question.

    uv run python examples/pandion/run_template.py text precision samples/chunking-primer/chunking-primer.pdf
    uv run python examples/pandion/run_template.py tables balanced report.pdf "What was the revenue in 2024?"

The Vague questions and Chat answer templates call Claude, so they need
ANTHROPIC_API_KEY. The first run downloads the models the templates use.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pandion
from pandion import Pipeline

DEFAULT_QUESTION = "What is this document about?"


def main(
    index: str,
    query: str,
    pdf: Path,
    question_text: str = DEFAULT_QUESTION,
    *,
    work: Path = Path("pandion-template-example"),
    embedder: str | None = None,
):
    """Index `pdf` with the two templates, ask `question_text` and print the hits."""
    config = pandion.compose_template(index, query, path=str(work))
    if embedder:
        config["index"]["embed"]["use"] = embedder
    listed = pandion.list_templates()
    index_name = next(t["name"] for t in listed["index"] if t["id"] == index)
    asked = next(t for t in listed["query"] if t["id"] == query)
    query_name = asked["name"]
    credentials = None
    if asked["needs_key"]:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise SystemExit(f"{query_name} needs an API key. Set ANTHROPIC_API_KEY.")
        credentials = {"anthropic_api_key": key}

    print(f"Pipeline: {index_name} with {query_name}.")
    p = Pipeline.from_dict(config)
    indexed = p.index.run(pdf)
    print(f"Indexed {pdf.name}: {'ok' if indexed.ok else 'failed'}.")
    answer = p.ask(question_text, credentials=credentials)
    print(f"Asked: {question_text}")
    for hit in answer.hits:
        text = " ".join(hit.chunk.text.split())
        print(f"Hit {hit.rank} (score {hit.score:.3f}): {text[:100]}")
    if answer.output is not None and answer.output.kind == "chat":
        print(f"Answer: {answer.text}")
    return answer


if __name__ == "__main__":
    listed = pandion.list_templates()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("index", choices=[t["id"] for t in listed["index"]], help="the index template")
    parser.add_argument("query", choices=[t["id"] for t in listed["query"]], help="the query template")
    parser.add_argument("pdf", type=Path, help="the PDF to index")
    parser.add_argument("question_text", nargs="?", default=DEFAULT_QUESTION, help="the question to ask")
    parser.add_argument("--work", type=Path, default=Path("pandion-template-example"), help="where the index goes")
    args = parser.parse_args()
    main(args.index, args.query, args.pdf, args.question_text, work=args.work)
