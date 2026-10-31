"""Take it home: the pipeline on Build as a ready-to-run project zip (`POST /api/project.zip`).

The route calls `pandion.new_project` into a fresh temporary folder, zips the
folder in memory and removes it. What goes in is only what the request sends:
the pipeline, and optionally a question set and a line of scores. Nothing from
the data folder (no document, no index), no key and no server path. With
`?preview=1` it answers with the same files as JSON, for the page to show.
"""

from __future__ import annotations

import io
import json
import re
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ValidationError

import pandion
from pandion.evaluation import QuestionSetError, parse_question_set
from pandion_api.checks import steps
from pandion_api.credentials import PROVIDERS
from pandion_api.pipelines import NOT_A_MAPPING, YAML_PATH
from pandion_api.routes.questions import MAX_GOLDS, MAX_QUESTIONS, MAX_SET_BYTES

from playground.backend import demo
from playground.backend.policy import demo_limited, scrub_paths

router = APIRouter()

#: The most a request may be: a question set at its own cap, with room for the pipeline.
MAX_BODY_BYTES = 2 * MAX_SET_BYTES
TOO_BIG = "The request is larger than 2 MB. Take home a smaller question set."
#: The 400 for a pipeline whose parts are not in the file's shape, such as a list where a mapping goes.
MALFORMED = "The pipeline is not in the pipeline file's shape, so it cannot be packed."
#: The scores line is display text: it is cut to this many characters.
MAX_SCORES_CHARS = 200
#: The zip's name when the pipeline has none that makes a file name.
DEFAULT_SLUG = "rag-pipeline"

#: A model's provider, as the catalog's `x-providers` names it, and the key slot it reads.
_SLOTS = {"anthropic": "anthropic", "openai": "openai", "openrouter": "openrouter", "openai_compatible": "custom"}


class ProjectIn(BaseModel):
    config: Any
    #: The pipeline's name on the page; the zip and its folder are named after it.
    name: str = ""
    #: A question set in the format Evaluate sends; left out, the project asks one example question.
    questions: list[dict[str, Any]] | dict[str, Any] | None = None
    #: The Evaluate result to beat, such as "11 of 12 found, MRR 0.88".
    scores: str = ""


def slug(name: str) -> str:
    """`name` as a short file name: lower case ASCII letters, digits and dashes."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    words = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return words[:60].rstrip("-") or DEFAULT_SLUG


def _scrubbed(value: Any, data_dir: Path | None) -> Any:
    """`value` with `scrub_paths` run over every string in it, keys and values."""
    if isinstance(value, str):
        return scrub_paths(value, data_dir)
    if isinstance(value, dict):
        return {_scrubbed(k, data_dir): _scrubbed(v, data_dir) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrubbed(v, data_dir) for v in value]
    return value


def _keys(config: dict[str, Any]) -> list[dict[str, Any]]:
    """The environment variable of each key the pipeline's model steps read.
    `optional` is true for a custom endpoint, which needs one only if its server asks."""
    catalog = pandion.catalog()
    found: list[dict[str, Any]] = []
    for _, stage, use, settings in steps(config):
        field = catalog.get(stage, {}).get(use, {}).get("config_schema", {}).get("properties", {}).get("model")
        if not field or not field.get("x-providers"):
            continue
        slot = _SLOTS.get(field["x-providers"].get(settings.get("model", field.get("default")), ""))
        if slot is None:
            continue
        key = {"variable": PROVIDERS[slot].env_var, "optional": slot == "custom"}
        if key not in found:
            found.append(key)
    return found


def _extra(limited: list[dict[str, Any]], scores: str) -> str:
    """The README's own sections: the settings the demo limited, and the scores to beat."""
    parts = []
    if limited:
        lines = "\n".join(f"- `{x['setting']}` is {x['value']}, the most the demo allows." for x in limited)
        parts.append(
            "## Settings the demo limited\n\n"
            "The hosted demo caps some settings. This project uses them as you set them there. "
            f"Raise them here if you like.\n\n{lines}"
        )
    if scores:
        parts.append(
            "## Scores to beat\n\n"
            f"On RAG Playground, with the same documents and questions: {scores}. Change a step and run it again."
        )
    return "\n\n".join(parts)


def _questions(questions: list[dict[str, Any]] | dict[str, Any], request: Request) -> dict[str, Any]:
    """The request's set, held to an uploaded set's caps, then to the Policy's question count."""
    try:
        parsed = parse_question_set(
            json.dumps(questions).encode("utf-8"), one_document=False, max_questions=MAX_QUESTIONS, max_golds=MAX_GOLDS
        )
    except QuestionSetError as exc:
        raise HTTPException(status_code=400, detail=f"The question set cannot be used: {str(exc).rstrip('.')}.") from None
    count = len(parsed["questions"])
    try:
        request.app.state.policy.check_question_count("evaluation", count, request)
    except HTTPException as exc:
        if exc.status_code != 413:
            raise
        raise HTTPException(status_code=413, detail=too_many(count)) from None
    return {"version": parsed["version"], "document": parsed["document"], "questions": parsed["questions"]}


def max_questions() -> int | None:
    """The most questions a project may hold: the demo's cap on one evaluation, none locally."""
    return demo.MAX_EVALUATION_QUESTIONS if demo.enabled() else None


def too_many(count: int) -> str:
    """The 413 for a set over the demo's cap, said as a take-home sentence."""
    return (
        f"The demo packs at most {demo.MAX_EVALUATION_QUESTIONS} questions into a project, and this set has {count}. "
        "Leave the questions out, or run the playground locally to take them all."
    )


def _build(name: str, pipeline: dict[str, Any], questions: dict[str, Any] | None, extra: str) -> dict[str, str]:
    """The project's files by their path, as text. The folder is gone when this returns."""
    with tempfile.TemporaryDirectory(prefix="rag-playground-project-") as tmp:
        folder = Path(tmp) / name
        written = pandion.new_project(folder, pipeline, questions, readme_extra=extra)
        return {p.relative_to(folder).as_posix(): p.read_text(encoding="utf-8") for p in written}


def _zip(name: str, files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for path, text in files.items():
            z.writestr(f"{name}/{path}", text)
    return buffer.getvalue()


async def _body(request: Request) -> ProjectIn:
    """The request, read up to MAX_BODY_BYTES (a 413 past it), as a ProjectIn."""
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail=TOO_BIG)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail=TOO_BIG)
    try:
        return ProjectIn.model_validate_json(bytes(data))
    except ValidationError:
        raise HTTPException(status_code=400, detail="The request must be JSON with the pipeline in config.") from None


@router.post("/project.zip")
async def project_zip(request: Request, preview: bool = False) -> Response:
    """The project as a zip named after the pipeline, or with `?preview=1` its files as JSON.

    Any key the request carries is ignored: the project only names the
    environment variable a key is read from."""
    body = await _body(request)
    if not isinstance(body.config, dict):
        raise HTTPException(status_code=400, detail=NOT_A_MAPPING)
    data_dir = request.app.state.settings.data_dir
    # The server decides the paths: the request's own path and models never reach the project.
    pipeline = _scrubbed({k: v for k, v in body.config.items() if k not in ("path", "models")}, data_dir)
    pipeline["path"] = YAML_PATH
    questions = await run_in_threadpool(_questions, body.questions, request) if body.questions is not None else None
    scores = " ".join(body.scores.split())[:MAX_SCORES_CHARS]
    name = slug(body.name)
    try:
        limited = demo_limited(pipeline)
        files = await run_in_threadpool(_build, name, pipeline, questions, _extra(limited, scores))
        keys = _keys(pipeline) if preview else []
    except ValueError as exc:  # ConfigError is a ValueError, and so is new_project's own refusal
        raise HTTPException(status_code=400, detail=scrub_paths(str(exc), data_dir)) from None
    except (TypeError, AttributeError):  # a part of the pipeline that is not in the file's shape
        raise HTTPException(status_code=400, detail=MALFORMED) from None
    filename = f"{name}.zip"
    if preview:
        body_json = {"filename": filename, "files": files, "limited": limited, "keys": keys, "max_questions": max_questions()}
        return Response(json.dumps(body_json), media_type="application/json")
    return Response(
        _zip(name, files),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
