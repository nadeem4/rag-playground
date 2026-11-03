"""POST /projects/serve: the deployable serve project (`pandion.new_project(kind="serve")`).

The request sends the pipeline, its questions per category and where the
project will run. The route writes the project into a temporary folder, zips it
in memory and removes the folder. Nothing from the server goes in: no
document, no index, no key and no server path. With `?preview=1` it answers
with the same files as JSON.
"""

from __future__ import annotations

import io
import json
import re
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ValidationError

import pandion
from pandion.evaluation import QuestionSetError, parse_question_set
from pandion_api.pipelines import NOT_A_MAPPING, YAML_PATH
from pandion_api.routes.questions import MAX_GOLDS, MAX_QUESTIONS, MAX_SET_BYTES

router = APIRouter()

#: The most a request may be: question sets at their own cap, with room for the pipeline.
MAX_BODY_BYTES = 2 * MAX_SET_BYTES
TOO_BIG = "The request is larger than 2 MB. Export fewer questions."
MALFORMED = "The pipeline is not in the pipeline file's shape, so it cannot be packed."
DEFAULT_SLUG = "rag-pipeline"


class CategoryIn(BaseModel):
    questions: list[dict[str, Any]] | dict[str, Any]
    #: True when the questions came from a sample: they are never exported.
    sample: bool = False


class WhereIn(BaseModel):
    source: str = "./docs"
    index_store: Literal["lancedb", "qdrant"] = "lancedb"
    index_url: str = "./index"


class ServeProjectIn(BaseModel):
    config: Any
    name: str = ""
    categories: dict[str, CategoryIn] = {}
    where: WhereIn = WhereIn()


def slug(name: str) -> str:
    """`name` as a short file name: lower case ASCII letters, digits and dashes."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:60].rstrip("-") or DEFAULT_SLUG


def _scrubbed(value: Any, scrub: Any) -> Any:
    """`value` with the Policy's `scrub` run over every string in it, keys and values."""
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, dict):
        return {_scrubbed(k, scrub): _scrubbed(v, scrub) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrubbed(v, scrub) for v in value]
    return value


def _keys(env_example: str) -> list[dict[str, Any]]:
    """Each `VAR=` line of the generated .env.example as `{variable, optional, note}`, the
    comment line above it being the note. A variable is optional when its note says an
    empty value works, or that only a custom server may need it."""
    found: list[dict[str, Any]] = []
    note = ""
    for line in env_example.splitlines():
        if line.startswith("# ") and not line.startswith("# Names only") and not line.startswith("# Optional"):
            note = line[2:]
        elif re.match(r"^[A-Z][A-Z0-9_]*=", line):
            optional = "empty" in note.lower() or "openai compatible" in note.lower()
            found.append({"variable": line.split("=", 1)[0], "optional": optional, "note": note})
            note = ""
        else:
            note = ""
    return found


def _question_set(category: str, questions: Any) -> dict[str, Any]:
    if isinstance(questions, dict) and not isinstance(questions.get("questions"), list):
        raise HTTPException(
            status_code=400, detail=f"The questions of category '{category}' must be a list, or an object with a 'questions' list."
        )
    try:
        parsed = parse_question_set(
            json.dumps(questions).encode("utf-8"), one_document=False, max_questions=MAX_QUESTIONS, max_golds=MAX_GOLDS
        )
    except QuestionSetError as exc:
        raise HTTPException(
            status_code=400, detail=f"The questions of category '{category}' cannot be used: {str(exc).rstrip('.')}."
        ) from None
    return {"version": parsed["version"], "document": parsed["document"], "questions": parsed["questions"]}


def _exportable(body: ServeProjectIn, config: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """The question sets to write (by category) and the categories left out, each with its reason."""
    # Pandion names the categories: a plain pipeline (none given) is one, called "default".
    known = pandion.Pipeline.from_dict(config, base=Path(".")).config.index.categories
    kept: dict[str, Any] = {}
    left: list[dict[str, str]] = []
    for category, sent in body.categories.items():
        if category not in known:
            raise HTTPException(
                status_code=400,
                detail=f"The pipeline has no category '{category}'. Its categories are: {', '.join(known) or 'none'}.",
            )
        if sent.sample:
            left.append({"id": category, "reason": "sample questions only"})
            continue
        listed = sent.questions if isinstance(sent.questions, list) else sent.questions.get("questions", [""])
        if not listed:  # an empty set is not a valid question set, and not an error here
            left.append({"id": category, "reason": "no questions"})
            continue
        kept[category] = _question_set(category, sent.questions)
    return kept, left


def _build(name: str, pipeline: dict[str, Any], kept: dict[str, Any], where: WhereIn) -> dict[str, str]:
    """The project's files by their path, as text. The folder is gone when this returns."""
    with tempfile.TemporaryDirectory(prefix="pandion-serve-project-") as tmp:
        folder = Path(tmp) / name
        written = pandion.new_project(
            folder, pipeline, kind="serve", categories_questions=kept,
            source=where.source, index_store=where.index_store, index_url=where.index_url,
        )
        return {p.relative_to(folder).as_posix(): p.read_text(encoding="utf-8") for p in written}


def _zip(name: str, files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for path, text in files.items():
            z.writestr(f"{name}/{path}", text)
    return buffer.getvalue()


async def _body(request: Request) -> ServeProjectIn:
    """The request, read up to MAX_BODY_BYTES (a 413 past it)."""
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail=TOO_BIG)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail=TOO_BIG)
    try:
        return ServeProjectIn.model_validate_json(bytes(data))
    except ValidationError as exc:
        if any(e["loc"][:2] == ("where", "index_store") for e in exc.errors()):
            raise HTTPException(status_code=422, detail="index_store must be 'lancedb' or 'qdrant'.") from None
        raise HTTPException(status_code=400, detail="The request must be JSON with the pipeline in config.") from None


@router.post("/projects/serve")
async def serve_project(request: Request, preview: bool = False) -> Response:
    """The serve project as a zip named after the pipeline, or with `?preview=1` its files as JSON.

    Any key the request carries is ignored: the project only names the
    environment variable a key is read from. `left_out.lock` says uv.lock is not
    shipped: the team runs `uv lock` once and commits it."""
    policy = request.app.state.policy
    body = await _body(request)
    if not isinstance(body.config, dict):
        raise HTTPException(status_code=400, detail=NOT_A_MAPPING)
    # The server decides the paths: the request's own path and models never reach the project.
    pipeline = _scrubbed({k: v for k, v in body.config.items() if k not in ("path", "models")}, policy.scrub)
    pipeline["path"] = YAML_PATH
    try:
        kept, left = _exportable(body, pipeline)
        total = sum(len(s["questions"]) for s in kept.values())
        try:
            policy.check_question_count("evaluation", total, request)
        except HTTPException as exc:
            if exc.status_code != 413:
                raise
            found = re.search(r"\d+", str(exc.detail).split(" has ")[-1])
            count = found.group() if found else total
            raise HTTPException(
                status_code=413,
                detail=f"This server packs fewer questions into a download than the {count} you sent. Leave some out, or run it yourself to take them all.",
            ) from None
        name = slug(body.name)
        files = await run_in_threadpool(_build, name, pipeline, kept, body.where)
        keys = _keys(files[".env.example"]) if preview else []
    except ValueError as exc:  # ConfigError is a ValueError, and so is new_project's own refusal
        raise HTTPException(status_code=400, detail=policy.scrub(str(exc))) from None
    except (TypeError, AttributeError):  # a part of the pipeline that is not in the file's shape
        raise HTTPException(status_code=400, detail=MALFORMED) from None
    if preview:
        out = {
            "filename": f"{name}.zip", "files": files, "keys": keys,
            "left_out": {"categories": left, "documents": True, "lock": True},
        }
        return Response(json.dumps(out), media_type="application/json")
    return Response(
        _zip(name, files),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.zip"'},
    )
