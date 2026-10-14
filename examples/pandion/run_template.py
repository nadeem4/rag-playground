"""Run a document template and a question template together with Pandion.

The templates are in playground/templates: a document template sets how a
document is read and indexed, a question template how it is searched and
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

from pandion import Pipeline
from playground import templates

DEFAULT_QUESTION = "What is this document about?"


def main(
    document: str,
    question: str,
    pdf: Path,
    question_text: str = DEFAULT_QUESTION,
    *,
    work: Path = Path("pandion-template-example"),
    embedder: str | None = None,
):
    """Index `pdf` with the two templates, ask `question_text` and print the hits."""
    config = templates.compose(document, question, path=str(work))
    if embedder:
        config["index"]["embed"]["use"] = embedder
    document_name = templates.load("documents")[document]["template"]["name"]
    question_name = templates.load("questions")[question]["template"]["name"]
    credentials = None
    if templates.needs_key(question):
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise SystemExit(f"{question_name} needs an API key. Set ANTHROPIC_API_KEY.")
        credentials = {"anthropic_api_key": key}

    print(f"Pipeline: {document_name} with {question_name}.")
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
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("document", choices=sorted(templates.load("documents")), help="the document template")
    parser.add_argument("question", choices=sorted(templates.load("questions")), help="the question template")
    parser.add_argument("pdf", type=Path, help="the PDF to index")
    parser.add_argument("question_text", nargs="?", default=DEFAULT_QUESTION, help="the question to ask")
    parser.add_argument("--work", type=Path, default=Path("pandion-template-example"), help="where the index goes")
    args = parser.parse_args()
    main(args.document, args.question, args.pdf, args.question_text, work=args.work)
