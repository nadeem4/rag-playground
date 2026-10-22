"""Starting a run, and the documents it reads."""

from __future__ import annotations

import threading
from typing import Any, Callable

from fastapi import HTTPException, Request

from pandion_api.credentials import guarded, redact
from pandion_api.documents import NO_SUCH_DOCUMENT, SHA, safe_name

#: What a run's work does on the worker thread: given the event callback, the
#: cancel event and the keys (None when there are none), it returns
#: (ok, cancelled, result) with a plain JSON result.
Work = Callable[[Callable[[dict[str, Any]], None], threading.Event, dict[str, str] | None], tuple[bool, bool, Any]]


def documents_of(shas: list[str], request: Request) -> dict[str, str]:
    """{document name: stored file} for a run, named as each was uploaded, so
    the same bytes under the same name always give the same result ids. A file
    with no record takes the name `Policy.document_name` gives it, else its
    stored file's name."""
    store = request.app.state.documents
    policy = request.app.state.policy
    out: dict[str, str] = {}
    for sha in shas:
        if not SHA.match(sha):
            raise HTTPException(status_code=404, detail=NO_SUCH_DOCUMENT)
        if not policy.can_read(sha, request):
            raise HTTPException(status_code=403, detail=policy.not_readable)
        path = store.file(sha)
        if path is None:
            raise HTTPException(status_code=404, detail=NO_SUCH_DOCUMENT)
        document = store.get(sha)
        given = policy.document_name(sha, request) if document is None else None
        name = safe_name(document.filename) if document is not None else safe_name(given) if given else path.name
        if name in out:
            raise HTTPException(
                status_code=400,
                detail=f"Two documents are both named {name}. Upload one of them under another name.",
            )
        out[name] = str(path)
    return out


def scrub_errors(value: Any, scrub: Callable[[str], str]) -> Any:
    """`value` with `scrub` applied to every string under an `error` key, at any depth."""
    if isinstance(value, dict):
        return {
            k: scrub(v) if k == "error" and isinstance(v, str) else scrub_errors(v, scrub)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return type(value)(scrub_errors(v, scrub) for v in value)
    return value


def too_many_runs(most: int) -> str:
    """The 429 for an owner who already has `most` runs going."""
    runs = "run" if most == 1 else "runs"
    return f"You already have {most} {runs} going. Wait for one to finish, or stop one."


def start(request: Request, kind: str, work: Work) -> dict[str, str]:
    """Start `work` on the app's run manager with this request's keys, as this
    request's owner (`Policy.run_owner`). Every event and the result are
    scrubbed of the keys, and their error text goes through `Policy.scrub`; a
    `run_cancelled` event marks the run cancelled. An owner who already has
    `Policy.max_runs_per_owner` runs working or waiting is refused with a 429."""
    policy = request.app.state.policy
    owner = policy.run_owner(request)
    most = policy.max_runs_per_owner(request)
    if owner is not None and most is not None:
        going = sum(1 for s in request.app.state.runs.active() if s.owner == owner)
        if going >= most:
            raise HTTPException(status_code=429, detail=too_many_runs(most))
    credentials = policy.credentials(request)
    keys = list(credentials.values())

    def clean(value: Any) -> Any:
        return scrub_errors(redact(value, keys), policy.scrub)

    def job(emit, cancel):
        seen: list[bool] = []

        def on_event(e: dict[str, Any]) -> None:
            if e.get("event") == "run_cancelled":
                seen.append(True)
            emit(clean(e))

        ok, cancelled, result = guarded(keys, lambda: work(on_event, cancel, credentials or None))
        return ok, cancelled or bool(seen), clean(result)

    state = request.app.state.runs.start(
        kind, job, owner=owner, scrub=lambda text: policy.scrub(redact(text, keys))
    )
    return {"run_id": state.run_id}
