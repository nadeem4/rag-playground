"""Bring your own gold set: the template, and a set stored against a document.

A set belongs to one document, keyed by that document's fingerprint
(`<sources dir>/questions/<sha>.json`), so a set written for the handbook can
never be applied to the invoice by accident.

Every upload is checked against the document as `pdfium` reads it, and the
report says so: a different parser can put the text together differently, and a
passage that matches here could still miss there. A set with passages that were
not found is stored anyway. A partly good set is still useful, and refusing it
would leave the reader with nothing to fix.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import pypdfium2 as pdfium
from fastapi import APIRouter, HTTPException, Query, Request, Response, UploadFile

from api import demo
from api.questions import (
    GOLD_SEPARATOR,
    QuestionSetError,
    check_questions,
    parse_question_set,
)
from api.routes.pages import source_path
from core.ports import RunContext, Stage
from core.registry import registry
from plugins.chunk import DocView

router = APIRouter()

#: The parser the check reads the document with. Fast, and no model.
PARSER = "pdfium"

PARSER_NOTE = (
    "The gold passages were looked for in the document as the pdfium parser "
    "reads it. Another parser can put the same text together differently, so a "
    "passage found here can still miss there, and the other way round."
)

#: A hosted demo checks a set and hands the result back, but keeps nothing, so
#: one visitor's questions never reach another's browser.
NO_STORING = (
    "this hosted demo checked your questions but did not keep them, so they "
    "live in this browser tab only; run the playground locally to keep a set"
)

#: Where a set lives, under the configured sources directory.
QUESTIONS_DIR = "questions"

#: Two real questions about the bundled sample, with every optional field
#: filled in, so nobody has to read a spec. The gold passages are copied out of
#: `samples/questions.json`, and `tests/api/test_questions.py` checks they
#: still are.
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


@router.post("/sources/{sha}/questions")
async def upload_questions(sha: str, request: Request, file: UploadFile) -> dict[str, Any]:
    """Check every gold passage, and store the set unless this is a hosted demo."""
    path = source_path(request, sha)
    try:
        parsed = parse_question_set(await file.read(), file.filename or "")
    except QuestionSetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    rows = check_questions(parsed["questions"], _document_text(path))
    record = {
        "sha": sha,
        "filename": Path(file.filename or "questions.json").name,
        "format": parsed["format"],
        "count": len(parsed["questions"]),
        "set": {
            "version": parsed["version"],
            "document": parsed["document"],
            "questions": parsed["questions"],
        },
    }
    keep = not demo.enabled()
    if keep:
        stored = _store(request, sha)
        stored.parent.mkdir(parents=True, exist_ok=True)
        stored.write_text(json.dumps(record), encoding="utf-8")

    return {
        **record,
        "stored": keep,
        "note": "" if keep else NO_STORING,
        "parser": PARSER,
        "parser_note": PARSER_NOTE,
        "summary": {
            "questions": len(rows),
            "found": sum(r["status"] == "found" for r in rows),
            "found_normalized": sum(r["status"] == "found_normalized" for r in rows),
            "not_found": sum(r["status"] == "not_found" for r in rows),
        },
        "questions": rows,
    }


@router.get("/sources/{sha}/questions")
def get_questions(sha: str, request: Request) -> dict[str, Any]:
    """The set stored for this document."""
    source_path(request, sha)  # 404 for a document this request may not read
    stored = _store(request, sha)
    if not stored.is_file():
        raise HTTPException(status_code=404, detail=f"no question set for {sha}")
    return json.loads(stored.read_text(encoding="utf-8"))


@router.delete("/sources/{sha}/questions", status_code=204)
def delete_questions(sha: str, request: Request) -> Response:
    """Remove it. Removing what is not there is not an error."""
    source_path(request, sha)
    _store(request, sha).unlink(missing_ok=True)
    return Response(status_code=204)


def _store(request: Request, sha: str) -> Path:
    """Where this document's set lives. Its directory is made on the way in."""
    sources: Path = request.app.state.deps.sources_dir
    return sources / QUESTIONS_DIR / f"{sha}.json"


def _document_text(path: Path) -> str:
    """The document as `pdfium` reads it: the same text the chunkers cut."""
    cls = registry.get(Stage.PARSE, PARSER)
    try:
        with TemporaryDirectory() as tmp:
            ctx = RunContext(output_dir=Path(tmp), emit=lambda event: None, tmp=Path(tmp))
            doc = cls().apply(
                {"file": {"path": str(path), "sha": "", "filename": path.name}},
                cls.config_model(),
                ctx,
            )
    except pdfium.PdfiumError as exc:
        raise HTTPException(
            status_code=415,
            detail="this source is not a PDF, so its text cannot be checked",
        ) from exc
    return DocView.of(doc).text
