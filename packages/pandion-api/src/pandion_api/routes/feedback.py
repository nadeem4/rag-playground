"""POST /feedback in serve mode: the user who owns a trace says it was good or bad.

The route is thin: `pandion.extend.give_feedback` checks the value, the lengths and
the owner. A trace that is missing and one that is another user's are the same 404.
The question, the answer and the comment are never logged or used as a metric label.
"""

from __future__ import annotations

import anyio
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from pandion.extend import TracesNotKept, give_feedback
from pandion_api.limits import TOO_FAST
from pandion_api.policy import AnonymousPolicy

router = APIRouter()

NO_TRACES = "This server's conversation store does not keep traces."
NO_TRACE = "There is no trace with that id."
NEEDS_USER = "Feedback needs a Policy that says who is asking. Policy.anonymous() gives every caller the same identity."


class FeedbackIn(BaseModel):
    trace_id: str
    value: str
    #: Lengths are checked by `give_feedback`, so a refusal never repeats the text.
    category: str = ""
    comment: str = ""


@router.post("/feedback")
async def feedback(body: FeedbackIn, request: Request):
    app = request.app.state
    app.policy.limit(request)
    if isinstance(app.policy, AnonymousPolicy):
        raise HTTPException(status_code=403, detail=NEEDS_USER)
    user_id = app.policy.user_id(request)
    if not user_id:
        raise HTTPException(status_code=403, detail=NEEDS_USER)
    if not app.feedback_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail=TOO_FAST)
    try:
        saved = await anyio.to_thread.run_sync(
            lambda: give_feedback(
                app.conversations, body.trace_id, user_id, body.value, category=body.category, comment=body.comment
            )
        )
    except TracesNotKept:
        raise HTTPException(status_code=501, detail=NO_TRACES) from None
    except ValueError as exc:  # one sentence that never repeats the text
        raise HTTPException(status_code=422, detail=str(exc)) from None
    if not saved:
        raise HTTPException(status_code=404, detail=NO_TRACE)
    if app.metrics:
        app.metrics.feedback(body.value, body.category)
    return {"ok": True}
