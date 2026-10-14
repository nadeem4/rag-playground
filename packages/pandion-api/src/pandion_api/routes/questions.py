"""A question set kept against one document, keyed by its id, so a set written
for one document can never be applied to another by accident.

Every set is checked against the document as the pdfium parser reads it, and
the report says so: another parser can put the text together differently. A
set with passages that were not found is kept anyway; a partly good set is
still useful, and refusing it would leave the reader nothing to fix.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool

import pandion
from pandion.evaluation import QuestionSetError, check_questions, document_text, parse_question_set
from pandion_api.deps import get_documents, get_policy
from pandion_api.documents import DocumentStore
from pandion_api.pages import PDFIUM_LOCK
from pandion_api.policy import Policy
from pandion_api.routes.documents import document_file

router = APIRouter()

#: The parser the check reads the document with: fast, and no model.
PARSER = "pdfium"
PARSER_NOTE = (
    "The gold passages were looked for in the document as the pdfium parser "
    "reads it. Another parser can put the same text together differently, so a "
    "passage found here can still miss there, and the other way round."
)


def _text(path: Path) -> str:
    """The document as pdfium reads it. pdfium is not thread-safe, so the parse
    holds the same lock as the page routes."""
    try:
        with PDFIUM_LOCK:
            return document_text(pandion.parse(path, use=PARSER))
    except pdfium.PdfiumError as exc:
        raise HTTPException(status_code=415, detail="this source is not a PDF, so its text cannot be checked") from exc


@router.post("/documents/{sha}/questions")
async def upload_questions(
    sha: str,
    request: Request,
    file: UploadFile,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    """Check every gold passage, and keep the set if the Policy keeps sets."""
    path = document_file(request, sha)
    try:
        parsed = parse_question_set(await file.read(), file.filename or "")
    except QuestionSetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    rows = check_questions(parsed["questions"], await run_in_threadpool(_text, path))
    record = {
        "sha": sha,
        "filename": Path(file.filename or "questions.json").name,
        "format": parsed["format"],
        "count": len(parsed["questions"]),
        "set": {"version": parsed["version"], "document": parsed["document"], "questions": parsed["questions"]},
    }
    keep = policy.keeps_question_sets(request)
    if keep:
        target = store.questions(sha)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(record), encoding="utf-8")
    return {
        **record,
        "stored": keep,
        "note": "" if keep else policy.not_keeping_note,
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


@router.get("/documents/{sha}/questions")
def get_questions(sha: str, request: Request, store: DocumentStore = Depends(get_documents)) -> dict[str, Any] | None:
    """The set kept for this document, or null when there is none: the usual answer, not an error."""
    document_file(request, sha)
    kept = store.questions(sha)
    return json.loads(kept.read_text(encoding="utf-8")) if kept.is_file() else None


@router.delete("/documents/{sha}/questions", status_code=204)
def delete_questions(sha: str, request: Request, store: DocumentStore = Depends(get_documents)) -> Response:
    """Remove it. Removing what is not there is not an error."""
    document_file(request, sha)
    store.questions(sha).unlink(missing_ok=True)
    return Response(status_code=204)
