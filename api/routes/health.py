"""`GET /api/health`: is the app up, and which build is it.

A deploy check reads this after a publish: `commit` is the Space variable
`RAG_PLAYGROUND_COMMIT` that `scripts/publish_space.py --commit` sets, so the
check can tell the build it just published from the one that was there before.
`version` is `RAG_PLAYGROUND_VERSION`, set by `--version`.
"""

from __future__ import annotations

import os
from importlib.metadata import PackageNotFoundError, version

from fastapi import APIRouter

from api import demo

router = APIRouter()


def _version() -> str:
    """The tag is the version: a publish sets RAG_PLAYGROUND_VERSION (the release
    tag on production, `<last tag>+<short sha>` on staging). Elsewhere, the package
    version, which is no longer bumped by hand."""
    published = os.environ.get("RAG_PLAYGROUND_VERSION", "")
    if published:
        return published
    try:
        return version("rag-playground")
    except PackageNotFoundError:
        return ""


@router.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "version": _version(),
        "commit": os.environ.get("RAG_PLAYGROUND_COMMIT", ""),
        "demo": demo.enabled(),
    }
