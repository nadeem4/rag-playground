"""Index runs, and the state, events and cancel of every run.

Every long job (an index run, a question, an evaluation, a comparison) is a run
on the app's run manager. The request is checked first, then answered 202 with
a run id; the work happens on a worker thread. Its events stream from
GET /runs/{id}/events, and GET /runs/{id} gives the log and, once it ended,
the result.

A run whose Policy named an owner (`Policy.run_owner`) is that owner's only:
to anyone else it is a 404, the same as a run that does not exist.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from pandion import Pipeline
from pandion.extend import UnreadableFormat, check_contents
from pandion_api import reports
from pandion_api.jobs import SortedIn, assign_to, documents_of, start
from pandion_api.pipelines import prepare
from pandion_api.runs import RunState, cancel_response, events_response, start_at

router = APIRouter()


class RunIn(SortedIn):
    config: Any
    #: Document ids (sha256), as POST /documents gave them.
    documents: list[str] = Field(min_length=1)
    #: The step to stop after: parse, clean, clean.N, chunk or index (the whole run).
    through: str | None = None
    force: bool = False


def check_through(p: Pipeline, through: str | None) -> None:
    """A `through` that names no step is a 400 before anything runs."""
    if through is None:
        return
    names = p.index.step_names()
    if through not in names:
        raise HTTPException(
            status_code=400,
            detail=f"through names the step to stop after: one of {', '.join(names)}, not '{through}'.",
        )


def refuse_disguised(documents: dict[str, str]) -> None:
    """A 415 before anything runs for a PDF or an image behind a Word,
    PowerPoint, HTML, Markdown or text file's name, the check POST
    /documents/{sha}/questions makes (`pandion.formats.check_contents`)."""
    for name, path in documents.items():
        try:
            check_contents(path, name)
        except UnreadableFormat as exc:
            raise HTTPException(status_code=415, detail=f"{exc}, so it cannot be indexed") from exc


@router.post("/runs", status_code=202)
async def create_run(body: RunIn, request: Request) -> dict[str, str]:
    """Index the documents, or run them through one step (`through`)."""
    p = prepare(body.config, request)
    check_through(p, body.through)
    documents = documents_of(body.documents, request)
    assign_to(p, body, list(documents))
    refuse_disguised(documents)

    def work(on_event, cancel, credentials):
        report = p.index.run(
            documents,
            through=body.through,
            on_event=on_event,
            cancel=cancel,
            credentials=credentials,
            force=body.force,
        )
        return report.ok, False, reports.index_report(report)

    return start(request, "index", work)


def find_run(request: Request, run_id: str) -> RunState:
    """The run, or a 404 when there is none or it is someone else's. The
    playground's old /api run routes call this too."""
    state = request.app.state.runs.get(run_id)
    if state is None or (state.owner is not None and state.owner != request.app.state.policy.run_owner(request)):
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")
    return state


@router.get("/runs/{run_id}")
def get_run(run_id: str, request: Request) -> dict[str, Any]:
    state = find_run(request, run_id)
    return {**state.snapshot(), "result": state.result}


@router.post("/runs/{run_id}/cancel", status_code=202)
def cancel_run(run_id: str, request: Request):
    return cancel_response(request.app.state.runs, find_run(request, run_id))


@router.get("/runs/{run_id}/events")
async def run_events(
    run_id: str,
    request: Request,
    last_event_id: str | None = Header(default=None),
    resume_after: str | None = Query(default=None, alias="last_event_id"),
):
    """The run's events from after `Last-Event-ID` (or `?last_event_id=N`, for a
    client that reconnects by itself), else from the start."""
    return events_response(find_run(request, run_id), start_at(last_event_id, resume_after))
