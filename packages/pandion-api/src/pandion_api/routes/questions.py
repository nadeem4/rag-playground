"""A question set kept against one document, keyed by its id, so a set written
for one document can never be applied to another by accident.

Every set is checked against the document's text: a PDF as the pdfium parser
reads it, and Word, PowerPoint, HTML, Markdown and text as docling reads them
(the one parser here that reads them, and with no model for these formats).
The report names the parser: another parser can put the text together
differently. An image would need OCR models, so its set cannot be checked, nor
can a PDF or an image behind another format's name, which docling would read
by its bytes with those models. A
set with passages that were not found is kept anyway; a partly good set is
still useful, and refusing it would leave the reader nothing to fix.

One set can also cover several documents (POST /questions). Each question may
name its `document`, by filename or sha: it is checked in that document only,
and one naming none is checked in every one. The set is kept split by document,
each document's named questions against it and the questions naming none
against every one, so removing a document loses none of them.
GET /questions returns the sets of several documents as one, and a run over
them (POST /evaluations without questions) asks every question once.

A set can also be written for a document by a model
(POST /documents/{sha}/questions/generate), as a run. That set is handed back,
never kept: the reader reviews it and uploads the questions they keep here.
Each written question names the document's sha as its `document`.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated, Any

import pypdfium2 as pdfium
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

import pandion
from pandion.evaluation import (
    QuestionSetError,
    check_questions,
    check_questions_across,
    document_text,
    documents_named,
    find_gold,
    parse_question_set,
    write_questions,
)
from pandion.extend import EndpointRefused, UnreadableFormat, format_of, guard_endpoint
from pandion_api.checks import chat_providers
from pandion_api.credentials import PROVIDERS
from pandion_api.deps import get_documents, get_policy
from pandion_api.documents import DocumentStore
from pandion_api.jobs import documents_of, start
from pandion_api.pages import PDFIUM_LOCK
from pandion_api.policy import Policy
from pandion_api.runs import event
from pandion_api.routes.documents import document_file

router = APIRouter()

#: The parser the check reads a PDF with: fast, and no model.
PARSER = "pdfium"
#: The parser for every other format it checks; for these formats it needs no model.
OTHER_PARSER = "docling"
#: The formats OTHER_PARSER reads here. Images are left out: they need OCR models.
OTHER_FORMATS = ("docx", "pptx", "html", "md", "txt")
#: Docling's converter is shared, so one conversion runs at a time.
DOCLING_LOCK = threading.Lock()
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


async def read_set(file: UploadFile, *, one_document: bool = True) -> dict[str, Any]:
    """The upload read as a question set: 413 past MAX_SET_BYTES (never more
    than one byte past it is read), 400 with the set's own sentence when it
    cannot be used. Parsing runs on a worker thread, so a large set never
    holds the event loop. `one_document`, as `parse_question_set` takes it:
    off for a set across several documents."""
    data = await file.read(MAX_SET_BYTES + 1)
    if len(data) > MAX_SET_BYTES:
        raise HTTPException(status_code=413, detail=TOO_BIG)
    try:
        return await run_in_threadpool(
            lambda: parse_question_set(
                data, file.filename or "", one_document=one_document, max_questions=MAX_QUESTIONS, max_golds=MAX_GOLDS
            )
        )
    except QuestionSetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def parser_note(parsers: list[str]) -> str:
    """PARSER_NOTE for the parser that read the document, or for several."""
    if len(set(parsers)) == 1:
        return PARSER_NOTE.replace(PARSER, parsers[0], 1)
    return (
        f"The gold passages were looked for in each document as {PARSER} for a PDF, "
        f"{OTHER_PARSER} for the others, reads it. " + PARSER_NOTE.split(". ", 1)[1]
    )


def _read(path: Path) -> tuple[str, str]:
    """The document's text and the parser that read it: pdfium for a PDF (or a
    file with no known format, as before), docling for Word, PowerPoint, HTML,
    Markdown and text. pdfium is not thread-safe, so its parse holds the same
    lock as the page routes. A file that cannot be read, or an image, is a 415."""
    kind = format_of(path.name)
    if kind == "png" or kind == "jpg":
        raise HTTPException(status_code=415, detail="this source is an image, so its text cannot be checked")
    if kind in OTHER_FORMATS:
        _refuse_disguised(path)
        try:
            with DOCLING_LOCK:
                return document_text(pandion.parse(path, use=OTHER_PARSER)), OTHER_PARSER
        except Exception as exc:  # noqa: BLE001 - docling's errors vary by format; the file cannot be read
            raise HTTPException(status_code=415, detail="this source cannot be read, so its text cannot be checked") from exc
    try:
        with PDFIUM_LOCK:
            return document_text(pandion.parse(path, use=PARSER)), PARSER
    except (pdfium.PdfiumError, UnreadableFormat) as exc:
        raise HTTPException(status_code=415, detail="this source is not a PDF, so its text cannot be checked") from exc


def _refuse_disguised(path: Path) -> None:
    """A 415 for a PDF or an image behind a Word, PowerPoint, HTML, Markdown
    or text file's name. Docling picks its reader by the bytes before the
    name, so such a file would run its layout or OCR models inside the
    request. The bytes are sniffed the way docling sniffs them (`filetype`)."""
    try:
        import filetype  # docling's own sniffer; without docling, the parse below fails as a 415
    except ImportError:
        return
    with path.open("rb") as f:
        head = f.read(8192)
    mime = filetype.guess_mime(head) or ""
    if head.startswith(b"%PDF") or mime == "application/pdf":
        held = "a PDF"
    elif mime.startswith("image/"):
        held = "an image"
    else:
        return
    raise HTTPException(
        status_code=415, detail=f"this file is named {path.suffix.lower()} but holds {held}, so its text cannot be checked"
    )


def _text(path: Path) -> str:
    """The document's text, as `_read` reads it."""
    return _read(path)[0]


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
    text, parser = await run_in_threadpool(_read, path)
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
        "parser": parser,
        "parser_note": parser_note([parser]),
        "summary": _summary(rows),
        "questions": rows,
    }


def named_documents(questions: list[dict[str, Any]], documents: dict[str, str], shas: list[str]) -> list[str | None]:
    """The sha of the document each question names, or None for one naming
    none. `documents` is what `documents_of(shas)` returns, by name; a
    question names a document by that name or its sha
    (`pandion.evaluation.documents_named`). A name that is neither is a 400
    with Pandion's sentence."""
    files = {name: SimpleNamespace(sha=sha, filename=name) for name, sha in zip(documents, shas)}
    try:
        named = documents_named(questions, files)
    except QuestionSetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return [None if name is None else files[name].sha for name in named]


@router.post("/questions")
async def upload_questions_across(
    request: Request,
    file: UploadFile,
    documents: Annotated[list[str], Form(min_length=1)],
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    """One set for several documents: check each gold passage in the document
    its question names, or in every one for a question naming none, and keep
    the set split by document if the Policy keeps sets: each document's named
    questions, and every question naming none, against each document, so
    removing one document loses none of them (`kept_questions` asks each one
    once). Each question's row names its document's sha (`document`, null when
    it names none) and each gold passage the sha of the document it was found
    in. A document the set has no question for loses the set it had: the new
    set replaces the old."""
    shas = list(dict.fromkeys(documents))
    names = documents_of(shas, request)
    parsed = await read_set(file, one_document=False)
    owners = named_documents(parsed["questions"], names, shas)
    read = {sha: await run_in_threadpool(_read, Path(path)) for sha, path in zip(shas, names.values())}
    texts = {sha: text for sha, (text, _) in read.items()}
    parsers = [parser for _, parser in read.values()]
    own = [{**q, "document": owner or ""} for q, owner in zip(parsed["questions"], owners)]
    rows = await run_in_threadpool(check_questions_across, own, texts)
    filename = Path(file.filename or "questions.json").name
    split = {sha: [q for q, owner in zip(parsed["questions"], owners) if owner in (sha, None)] for sha in shas}
    keep = policy.keeps_question_sets(request)
    if keep:
        for sha, questions in split.items():
            target = store.questions(sha)
            if not questions:
                target.unlink(missing_ok=True)
                continue
            record = {
                "sha": sha,
                "filename": filename,
                "format": parsed["format"],
                "count": len(questions),
                "set": {"version": parsed["version"], "document": "", "questions": questions},
                "across": shas,
            }
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(record), encoding="utf-8")
    return {
        "documents": shas,
        "filename": filename,
        "format": parsed["format"],
        "count": len(parsed["questions"]),
        "stored": keep,
        "note": "" if keep else policy.not_keeping_note,
        "parser": ", ".join(sorted(set(parsers))),
        "parser_note": parser_note(parsers),
        "summary": _summary(rows),
        "questions": rows,
    }


def kept_questions(store: DocumentStore, shas: list[str], names: list[str]) -> list[dict[str, Any]]:
    """The questions of the sets kept against these documents, in their order.
    A question that names a document names the one it is kept against, by
    sha; one naming none is found in any of them. A question naming none from
    one set across documents (POST /questions) is kept against each of them
    and asked once. An id two documents' sets both use is prefixed with each
    document's name, so every question stays apart."""
    sets: list[tuple[str, list[dict[str, Any]]]] = []
    shared: set[str] = set()
    for sha, name in zip(shas, names):
        kept = store.questions(sha)
        if not kept.is_file():
            continue
        record = json.loads(kept.read_text(encoding="utf-8"))
        questions = []
        for q in record["set"]["questions"]:
            if q.get("document"):
                questions.append({**q, "document": sha})
                continue
            if "across" in record:
                key = json.dumps(q, sort_keys=True)
                if key in shared:
                    continue
                shared.add(key)
            questions.append(q)
        sets.append((name, questions))
    owners: dict[str, set[str]] = {}
    for name, qs in sets:
        for q in qs:
            if q.get("id"):
                owners.setdefault(q["id"], set()).add(name)
    return [
        {**q, "id": f"{name}: {q['id']}"} if q.get("id") and len(owners[q["id"]]) > 1 else q
        for name, qs in sets
        for q in qs
    ]


@router.get("/questions")
def get_questions_across(
    request: Request,
    documents: Annotated[list[str], Query(min_length=1)],
    store: DocumentStore = Depends(get_documents),
) -> dict[str, Any]:
    """The sets kept against these documents as one, as an evaluation without
    questions asks them (`kept_questions`): each question's `document` is the
    sha of the document it names, or empty when it names none."""
    shas = list(dict.fromkeys(documents))
    names = documents_of(shas, request)
    questions = kept_questions(store, shas, list(names))
    return {"documents": shas, "count": len(questions), "questions": questions}


def _summary(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "questions": len(rows),
        "found": sum(r["status"] == "found" for r in rows),
        "found_normalized": sum(r["status"] == "found_normalized" for r in rows),
        "not_found": sum(r["status"] == "not_found" for r in rows),
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
                document=sha,
            )
        except _Cancelled:
            return False, True, None
        except HTTPException as exc:  # the document cannot be read
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
