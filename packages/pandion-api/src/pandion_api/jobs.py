"""Starting a run, and the documents it reads."""

from __future__ import annotations

import threading
from pathlib import PurePosixPath
from typing import Any, Callable

from fastapi import HTTPException, Request

from pandion_api.credentials import guarded, redact
from pandion_api.documents import NO_SUCH_DOCUMENT, SHA, suffix

#: What a run's work does on the worker thread: given the event callback, the
#: cancel event and the keys (None when there are none), it returns
#: (ok, cancelled, result) with a plain JSON result.
Work = Callable[[Callable[[dict[str, Any]], None], threading.Event, dict[str, str] | None], tuple[bool, bool, Any]]


def documents_of(shas: list[str], request: Request) -> dict[str, str]:
    """{document name: stored file} for a run, named as each was uploaded, so
    the same bytes under the same name always give the same result ids."""
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
        name = safe_name(document.filename) if document is not None else path.name
        if name in out:
            raise HTTPException(
                status_code=400,
                detail=f"Two documents are both named {name}. Upload one of them under another name.",
            )
        out[name] = str(path)
    return out


def safe_name(filename: str) -> str:
    """`filename` as a run names its document. Pandion keeps its own copy of a
    document as `<sha><the name's suffix>`, so a suffix the store would not keep
    (`documents.suffix`: a space, a `:` that names a Windows stream, too long) is
    dropped; the stored file has none either. A plain name such as `report.pdf`
    is unchanged, so its result ids are the old routes' ones."""
    found = PurePosixPath(filename).suffix
    if found and suffix(filename) != found:
        return filename[: -len(found)]
    return filename


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


def start(request: Request, kind: str, work: Work) -> dict[str, str]:
    """Start `work` on the app's run manager with this request's keys, as this
    request's owner (`Policy.run_owner`). Every event and the result are
    scrubbed of the keys, and their error text goes through `Policy.scrub`; a
    `run_cancelled` event marks the run cancelled."""
    policy = request.app.state.policy
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
        kind, job, owner=policy.run_owner(request), scrub=lambda text: policy.scrub(redact(text, keys))
    )
    return {"run_id": state.run_id}
