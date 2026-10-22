"""A question set kept against one document, keyed by its id, so a set written
for one document can never be applied to another by accident.

Every set is checked against the document as the pdfium parser reads it, and
the report says so: another parser can put the text together differently. A
set with passages that were not found is kept anyway; a partly good set is
still useful, and refusing it would leave the reader nothing to fix.

A set can also be written for a document by a model
(POST /documents/{sha}/questions/generate), as a run. That set is handed back,
never kept: the reader reviews it and uploads the questions they keep here.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Annotated, Any

import pypdfium2 as pdfium
from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

import pandion
from pandion.evaluation import (
    QuestionSetError,
    check_questions,
    document_text,
    find_gold,
    parse_question_set,
    write_questions,
)
from pandion.extend import EndpointRefused, UnreadableFormat, guard_endpoint
from pandion_api.checks import chat_providers
from pandion_api.credentials import PROVIDERS
from pandion_api.deps import get_documents, get_policy
from pandion_api.documents import DocumentStore
from pandion_api.jobs import start
from pandion_api.pages import PDFIUM_LOCK
from pandion_api.policy import Policy
from pandion_api.runs import event
from pandion_api.routes.documents import document_file

router = APIRouter()

#: The parser the check reads the document with: fast, and no model.
PARSER = "pdfium"
PARSER_NOTE = (
    "The gold passages were looked for in the document as the pdfium parser "
    "reads it. Another parser can put the same text together differently, so a "
    "passage found here can still miss there, and the other way round."
)

#: The most a question set may be, read, hold or check (`read_set`).
MAX_SET_BYTES = 1024 * 1024
MAX_QUESTIONS = 500
MAX_GOLDS = 20
TOO_BIG = "The question set is larger than 1 MB. Split it into smaller sets and upload each."


async def read_set(file: UploadFile) -> dict[str, Any]:
    """The upload read as a question set: 413 past MAX_SET_BYTES (never more
    than one byte past it is read), 400 with the set's own sentence when it
    cannot be used. Parsing runs on a worker thread, so a large set never
    holds the event loop."""
    data = await file.read(MAX_SET_BYTES + 1)
    if len(data) > MAX_SET_BYTES:
        raise HTTPException(status_code=413, detail=TOO_BIG)
    try:
        return await run_in_threadpool(
            parse_question_set, data, file.filename or "", max_questions=MAX_QUESTIONS, max_golds=MAX_GOLDS
        )
    except QuestionSetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _text(path: Path) -> str:
    """The document as pdfium reads it. pdfium is not thread-safe, so the parse
    holds the same lock as the page routes."""
    try:
        with PDFIUM_LOCK:
            return document_text(pandion.parse(path, use=PARSER))
    except (pdfium.PdfiumError, UnreadableFormat) as exc:
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
    parsed = await read_set(file)
    text = await run_in_threadpool(_text, path)
    rows = await run_in_threadpool(check_questions, parsed["questions"], text)
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


#: The most questions one generate run may ask for; a Policy may allow fewer.
MAX_GENERATED = 50
TOO_FEW = "Ask for at least one question."
TOO_MANY = f"A model writes at most {MAX_GENERATED} questions at a time. Ask for fewer."


class GenerateIn(BaseModel):
    model: str
    count: int = 15
    #: For `openrouter` and `custom`: the model's name at that provider.
    model_name: str | None = None
    #: For `custom`: the OpenAI-compatible server's base URL.
    base_url: str | None = None


class _Cancelled(Exception):
    """Raised between parts when the run is cancelled."""


@router.post("/documents/{sha}/questions/generate", status_code=202)
async def generate_questions(
    sha: str, body: GenerateIn, request: Request, policy: Policy = Depends(get_policy)
) -> dict[str, str]:
    """Have a model write up to `count` test questions for the document, as a run
    (`pandion.evaluation.write_questions`, one call a part). Follow it as any run:
    a `part_finished` event after each part, then the result, the dict
    `write_questions` returns. The set is not kept here: the reader reviews it,
    then uploads the questions they keep with POST /documents/{sha}/questions.

    Refused before the run starts: a count under 1 or over MAX_GENERATED (422),
    `Policy.check_question_count("generation", ...)`, an unknown model (422),
    `Policy.check_provider`, a custom endpoint that is not public where
    `Policy.public_endpoints_only` (403), and a missing key (400)."""
    path = document_file(request, sha)
    if body.count < 1:
        raise HTTPException(status_code=422, detail=TOO_FEW)
    if body.count > MAX_GENERATED:
        raise HTTPException(status_code=422, detail=TOO_MANY)
    policy.check_question_count("generation", body.count, request)
    providers = chat_providers()
    if body.model not in providers:
        raise HTTPException(
            status_code=422, detail=f"model must be one of {', '.join(providers)}; not '{body.model}'."
        )
    provider = "custom" if providers[body.model] == "openai_compatible" else providers[body.model]
    policy.check_provider(provider, request)
    public_only = policy.public_endpoints_only(request)
    if provider == "custom":
        try:
            await run_in_threadpool(guard_endpoint, body.base_url or "", public_only=public_only)
        except EndpointRefused as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from None
    elif PROVIDERS[provider].extra not in policy.credentials(request):
        raise HTTPException(status_code=400, detail=policy.missing_key(provider))

    def work(on_event, cancel: threading.Event, credentials):
        def on_part(done: int, total: int) -> None:
            on_event(event("part_finished", number=done, total=total))
            if cancel.is_set() and done < total:  # after the last part, the set is paid for: keep it
                raise _Cancelled

        try:
            result = write_questions(
                _text(path), model=body.model, count=body.count, credentials=credentials,
                model_name=body.model_name, base_url=body.base_url, public_only=public_only, on_part=on_part,
            )
        except _Cancelled:
            return False, True, None
        except HTTPException as exc:  # the document is not a PDF
            return False, False, {"error": exc.detail}
        except Exception as exc:  # noqa: BLE001 - the first call failed; scrubbed by jobs.start
            return False, False, {"error": str(exc)}
        return True, False, result

    return start(request, "questions", work)


#: The most pieces one /golds/find looks through: the most hits one ask keeps.
MAX_PIECES = 100
#: The most characters one gold passage may be.
MAX_TEXT_CHARS = 10_000
#: The most characters all the pieces together may be. A piece has no cap of
#: its own, so one long piece is looked through whole. With MAX_GOLDS and
#: MAX_TEXT_CHARS it bounds one call's work to under half a second, so the
#: route needs no rate limit of its own.
MAX_TOTAL_CHARS = 1_000_000

TOO_LONG = f"The pieces may be at most {MAX_TOTAL_CHARS:,} characters together. Send fewer."


class FindGoldIn(BaseModel):
    golds: list[Annotated[str, Field(max_length=MAX_TEXT_CHARS)]] = Field(min_length=1, max_length=MAX_GOLDS)
    texts: list[str] = Field(max_length=MAX_PIECES)

    @field_validator("texts")
    @classmethod
    def _within_total(cls, texts: list[str]) -> list[str]:
        if sum(len(t) for t in texts) > MAX_TOTAL_CHARS:
            raise ValueError(TOO_LONG)
        return texts


@router.post("/golds/find")
def find_golds(body: FindGoldIn) -> dict[str, Any]:
    """Which of `texts`, pieces in the order a reader meets them, first holds
    any of the gold passages, by the eval step's own rule
    (`pandion.evaluation.find_gold`): `found` is its place, the passage and the
    kind of match, or null. Nothing is stored and nothing runs."""
    found = find_gold(body.golds, body.texts)
    return {"found": None if found is None else {"index": found.index, "gold": found.gold, "match": found.match}}
