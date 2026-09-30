"""Demo mode, for a public host that strangers share (e.g. a Hugging Face Space).

On when `RAG_PLAYGROUND_DEMO=1`, read on every call so tests can flip it. In
demo mode: uploads are allowed but private to the browser that made them, the
bundled samples stay visible and readable to everyone, and the Anthropic key
comes only from the request header (`api.credentials`), so a visitor never
sees another visitor's file and never spends the host's key.
"""

from __future__ import annotations

import os
from datetime import timedelta

from fastapi import Request

ENV_VAR = "RAG_PLAYGROUND_DEMO"

#: Demo-mode upload limits: the Space has two CPUs and a shared disk.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_PAGES = 20
MAX_UPLOADS_PER_VISITOR = 3
UPLOAD_TTL = timedelta(hours=24)


def enabled() -> bool:
    return os.environ.get(ENV_VAR) == "1"


def limits() -> dict[str, int]:
    return {
        "max_bytes": MAX_UPLOAD_BYTES,
        "max_pages": MAX_UPLOAD_PAGES,
        "max_files": MAX_UPLOADS_PER_VISITOR,
        "ttl_hours": int(UPLOAD_TTL.total_seconds() // 3600),
    }


def readable(sha: str | None, request: Request) -> bool:
    """May this request read the source with this sha? Outside demo mode, any.
    In demo mode: a bundled sample, or an upload this visitor made."""
    from api import sample_set, visitor
    from api.routes.sources import owners

    if not enabled():
        return True
    if sha in sample_set.readable_shas():
        return True
    me = visitor.visitor_id(request)
    return bool(sha and me and me in owners(request.app.state.deps.sources_dir, sha))
