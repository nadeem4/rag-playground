"""The event envelope every run streams.

Events are plain dicts, never dataclasses or models, because they are destined
for an SSE `data:` line: whatever goes in must survive `json.dumps` unchanged.
A traceback is a string with newlines, so the framing is the consumer's job —
but a non-serializable value would break the stream outright, which is why
nothing richer than JSON is ever put in here.
"""

from __future__ import annotations

import time
from typing import Any, Callable

#: The callback a run uses to publish progress. Called from a worker thread.
Emit = Callable[[dict[str, Any]], None]


def event(kind: str, **fields: Any) -> dict[str, Any]:
    """Build one JSON-serializable event payload."""
    return {"event": kind, "ts": time.time(), **fields}
