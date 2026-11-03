"""Online flags and feedback: which turns a person should look at.

Provisional. `flags_for` names a turn that may have gone wrong, from facts the
answer already holds (no model call, no extra cost). `give_feedback` lets the
user who owns a trace say it was good or bad.

Flags:

- `low_grounding`: some claim is labelled `weak` or `none`.
- `declined`: the answer only said the documents do not answer it.
- `not_in_documents`: the search found no piece of any document.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from pandion.conversation_store import TraceStore
from pandion.trace_record import Feedback, _label


def flags_for(answer: Any) -> list[str]:
    """The flags of an answered turn, in a fixed order. An answer with none gives `[]`."""
    label = _label(answer)
    flags = []
    if label in ("weak", "none"):
        flags.append("low_grounding")
    if label == "not_found":
        flags.append("declined")
    hits = getattr(answer, "hits", None)
    if isinstance(hits, list) and not hits:
        flags.append("not_in_documents")
    return flags


def give_feedback(
    store: TraceStore, trace_id: str, user_id: str, value: str, *, category: str = "", comment: str = "",
) -> bool:
    """Record the user's feedback on their own trace.

    Returns False when the trace is missing or is not this user's. Raises
    `ValueError` with one sentence when `value` is not "up" or "down", the category
    is over 40 characters or the comment is over 500, or the store keeps no traces.
    The sentence never repeats the category or the comment.
    """
    if not isinstance(store, TraceStore):
        raise ValueError("This store does not keep traces, so it cannot take feedback.")
    try:
        feedback = Feedback(value=value, category=category, comment=comment)  # type: ignore[arg-type]
    except ValidationError as exc:
        field = str(exc.errors()[0]["loc"][0])
        raise ValueError({
            "value": "Feedback must be \"up\" or \"down\".",
            "category": "A feedback category can be at most 40 characters.",
            "comment": "A feedback comment can be at most 500 characters.",
        }[field]) from None
    return store.add_feedback(trace_id, user_id, feedback)
