"""Documents: upload, list and delete, each as the site's Policy allows."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile

from pandion_api.deps import get_documents, get_policy
from pandion_api.documents import SHA, DocumentStore
from pandion_api.policy import Policy

router = APIRouter()

NO_SUCH_DOCUMENT = "There is no document with that fingerprint."


@router.get("/documents")
def list_documents(
    request: Request,
    response: Response,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> list[dict[str, Any]]:
    """The documents this request may read, by name. Never cached: the list
    can differ for each caller."""
    response.headers["Cache-Control"] = "private, no-store"
    shown = [
        {**d.record(), **policy.describe(d, request)}
        for d in store.all()
        if policy.can_read(d.sha, request)
    ]
    return sorted(shown, key=lambda d: d["filename"].lower())


@router.post("/documents")
async def upload_document(
    request: Request,
    file: UploadFile,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    data = await policy.check_upload(file, request)
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    # Only the name's last part, and only its suffix reaches a path: the
    # stored file is `<sha><suffix>`, whatever the request called it.
    filename = Path(file.filename or "upload").name
    content_type = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    sha = store.save(data, filename)
    with store.lock:
        document = store.write(sha, filename, len(data), content_type)
        policy.on_uploaded(document, request)
    return store.get(sha).record()


@router.delete("/documents/{sha}")
def delete_document(
    sha: str,
    request: Request,
    store: DocumentStore = Depends(get_documents),
    policy: Policy = Depends(get_policy),
) -> dict[str, Any]:
    """Delete a document now, if the Policy agrees. `deleted` says whether the
    file left the disk: a Policy may keep it for someone else."""
    if not SHA.match(sha):
        raise HTTPException(status_code=404, detail=NO_SUCH_DOCUMENT)
    with store.lock:
        if not policy.on_delete(sha, store.get(sha), request):
            return {"sha": sha, "deleted": False}
        store.remove(sha)
    return {"sha": sha, "deleted": True}
