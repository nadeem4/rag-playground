"""What a serve caller sees when something fails: one sentence and a trace id.
The detail goes to the log under the same id."""

from __future__ import annotations

import logging
import uuid

logger = logging.getLogger("pandion_api")


def generic(trace_id: str) -> str:
    return f"Something went wrong. Quote this trace id when you ask for help: {trace_id}."


def hide(detail: str, trace_id: str | None = None) -> str:
    """Log `detail` at ERROR with a trace id and return the sentence for the caller."""
    trace_id = trace_id or uuid.uuid4().hex
    logger.error("Serve error (trace %s): %s", trace_id, detail)
    return generic(trace_id)
