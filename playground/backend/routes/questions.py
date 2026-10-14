"""Bring your own gold set: the template to fill in.

A filled-in set is checked and stored against its document by pandion-api
(`/api/v2/documents/{sha}/questions`). On a hosted demo it is checked but not
kept: `PlaygroundPolicy.keeps_question_sets` says no, and `NO_STORING` says why.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from fastapi import APIRouter, Query, Response

from pandion.evaluation import GOLD_SEPARATOR

router = APIRouter()

#: A hosted demo checks a set and hands the result back, but keeps nothing, so
#: one visitor's questions never reach another's browser.
NO_STORING = (
    "this hosted demo checked your questions but did not keep them, so they "
    "live in this browser tab only; run the playground locally to keep a set"
)

#: Two real questions about the bundled sample, with every optional field
#: filled in, so nobody has to read a spec. The gold passages are copied out of
#: `samples/chunking-primer/questions.json`, and `tests/api/test_questions.py`
#: checks they still are.
TEMPLATE: dict[str, Any] = {
    "version": 1,
    "document": "chunking-primer.pdf",
    "questions": [
        {
            "id": "two-steps",
            "question": (
                "What are the two steps a retrieval-augmented system takes to "
                "answer a question?"
            ),
            "gold_answers": [
                "Retrieval-augmented generation answers a question in two steps. "
                "First it finds passages that look relevant, then it asks a "
                "language model to answer from those passages alone."
            ],
            "answer": "It finds passages that look relevant, then answers from them alone.",
            "tags": ["basics"],
            "document": "chunking-primer.pdf",
        },
        {
            "id": "rule-of-thumb",
            "question": "How much should a single chunk cover?",
            "gold_answers": [
                "A useful rule of thumb: a chunk should answer one question well.",
                "Small chunks match a question closely, because every sentence in "
                "them is about the same thing.",
            ],
            "answer": "One question's worth.",
            "tags": ["chunking", "sizing"],
            "document": "chunking-primer.pdf",
        },
    ],
}

TEMPLATE_COLUMNS = ("id", "question", "gold_answers", "answer", "tags", "document")


@router.get("/questions/template")
def get_template(format: str = Query("json", pattern="^(json|csv)$")) -> Response:
    """A file to fill in: two worked examples, every optional field shown."""
    if format == "json":
        body = json.dumps(TEMPLATE, indent=2, ensure_ascii=False) + "\n"
        media = "application/json"
    else:
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(TEMPLATE_COLUMNS)
        for question in TEMPLATE["questions"]:
            writer.writerow(
                [
                    question["id"],
                    question["question"],
                    f" {GOLD_SEPARATOR} ".join(question["gold_answers"]),
                    question["answer"],
                    ", ".join(question["tags"]),
                    question["document"],
                ]
            )
        body = buffer.getvalue()
        media = "text/csv; charset=utf-8"
    return Response(
        body,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="questions-template.{format}"'
        },
    )
