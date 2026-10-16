"""Demo mode, for a public host that strangers share (e.g. a Hugging Face Space).

On when `RAG_PLAYGROUND_DEMO=1`, read on every call so tests can flip it. In
demo mode: uploads are allowed but private to the browser that made them, the
bundled samples stay visible and readable to everyone, and the Anthropic key
comes only from the request header (`playground.backend.credentials`), so a visitor never
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
#: The largest page side the demo takes, in points (72 a inch): about 41 inches.
#: Docling draws each page as an image, so a poster-sized page would take the shared memory.
MAX_PAGE_POINTS = 3000
#: Runs that do heavy work at the same time on the demo; the rest wait their turn.
#: Two cores and 16 GB serve every visitor, and several big parses at once run out of memory.
MAX_ACTIVE_RUNS = 2
#: Runs one visitor may have working or waiting at once on the demo, so one
#: visitor cannot fill the line in front of everyone else.
MAX_RUNS_PER_VISITOR = 2
#: The most questions one evaluation scores on the demo.
MAX_EVALUATION_QUESTIONS = 50
#: The most recipe-questions (recipes times questions) one comparison scores on the demo.
MAX_COMPARISON_QUESTIONS = 120
#: The most questions a model writes for a document in one run on the demo.
MAX_GENERATED_QUESTIONS = 25
#: The most pieces llm_context writes context for in one run on the demo (its
#: max_pieces), so one run makes at most this many model calls.
MAX_CONTEXT_PIECES = 200
#: All live uploads together, so a client that keeps getting new visitor ids
#: still cannot fill the shared disk.
MAX_TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024
UPLOAD_TTL = timedelta(hours=24)


def enabled() -> bool:
    return os.environ.get(ENV_VAR) == "1"


def public_endpoints_only() -> bool:
    """The second line of the custom endpoint ban: on the demo, a custom endpoint
    must be a public https address (`pandion.endpoints`).

    It reads the environment itself, not `enabled()`, which the routes' 403s
    read, so it holds even if that first line is lifted.
    """
    return os.environ.get(ENV_VAR) == "1"


def limits() -> dict[str, int]:
    return {
        "max_bytes": MAX_UPLOAD_BYTES,
        "max_pages": MAX_UPLOAD_PAGES,
        "max_files": MAX_UPLOADS_PER_VISITOR,
        "max_total_bytes": MAX_TOTAL_UPLOAD_BYTES,
        "ttl_hours": int(UPLOAD_TTL.total_seconds() // 3600),
    }


def readable(sha: str | None, request: Request) -> bool:
    """May this request read the source with this sha? Outside demo mode, any.
    In demo mode: a bundled sample, or an upload this visitor made."""
    from playground.backend import sample_set, visitor
    from playground.backend.routes.sources import owners

    if not enabled():
        return True
    if sha in sample_set.readable_shas():
        return True
    me = visitor.visitor_id(request)
    return bool(sha and me and me in owners(request.app.state.deps.sources_dir, sha))
