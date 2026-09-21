"""Artifact meta and payloads, and clearing the cache."""

from __future__ import annotations

import gc
import json
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from core.artifacts import ArtifactType
from core.storage import META, Store

router = APIRouter()

#: Full 64-hex artifact ids only; also keeps any path trickery out of the store.
_ID = re.compile(r"^[0-9a-f]{64}$")

#: `store.clear()` attempts, and the pause between them. Windows refuses to
#: delete a directory while anything (a LanceDB mmap) still holds a handle.
RETRIES = 5
RETRY_DELAY_S = 0.2

#: Inside an index artifact's directory, written by `plugins.index.lancedb_store`.
DESCRIPTOR = "descriptor.json"


def _require(store: Store, artifact_id: str) -> None:
    if not _ID.match(artifact_id) or not store.has(artifact_id):
        raise HTTPException(status_code=404, detail=f"unknown artifact {artifact_id}")


@router.get("/artifacts/{artifact_id}")
def get_artifact(artifact_id: str, request: Request) -> dict[str, Any]:
    store: Store = request.app.state.deps.store
    _require(store, artifact_id)
    a = store.get_meta(artifact_id)
    return {"id": a.id, "type": str(a.type), "meta": a.meta}


@router.get("/artifacts/{artifact_id}/payload")
def get_payload(artifact_id: str, request: Request) -> Any:
    store: Store = request.app.state.deps.store
    _require(store, artifact_id)
    a = store.get_meta(artifact_id)
    if a.type is ArtifactType.INDEX:
        # A directory holding a database: return its descriptor, not the data.
        descriptor = Path(store.load(artifact_id, a.type)) / DESCRIPTOR
        if not descriptor.is_file():
            raise HTTPException(status_code=404, detail="index has no descriptor")
        return json.loads(descriptor.read_text(encoding="utf-8"))
    return store.load(artifact_id, a.type)


def _usage(root: Path) -> tuple[int, int]:
    """(committed artifacts, total bytes) under the store root."""
    if not root.exists():
        return 0, 0
    files = [p for p in root.rglob("*") if p.is_file()]
    return sum(1 for p in files if p.name == META), sum(p.stat().st_size for p in files)


@router.delete("/cache")
def clear_cache(request: Request) -> dict[str, Any]:
    if request.app.state.runs.active():
        raise HTTPException(status_code=409, detail="a run is in progress")
    store: Store = request.app.state.deps.store
    artifacts, size = _usage(store.root)

    for attempt in range(RETRIES):
        try:
            store.clear()
        except PermissionError:
            pass
        if not store.root.exists():
            break
        gc.collect()  # drop any unreferenced LanceDB handle before retrying
        time.sleep(RETRY_DELAY_S)

    left_artifacts, left_size = _usage(store.root)
    return {
        "artifacts": artifacts - left_artifacts,
        "bytes": size - left_size,
        "complete": not store.root.exists(),
    }
