"""POST /ask in serve mode: one question, one answer, nothing stored.

It is /chat without a conversation: no history, no rewrite, no summary, no memory.
The reply has the same shape as /chat's JSON reply, with `conversation_id` null.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from pandion_api.jobs import start
from pandion_api.routes.chat import FAILED, _sources

router = APIRouter()
logger = logging.getLogger(__name__)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=8000)


@router.post("/ask")
async def ask(body: AskIn, request: Request):
    app = request.app.state
    policy = app.policy
    policy.limit(request)
    roles = policy.roles(request)
    policy.user_id(request)  # so a Policy can refuse the caller (401), though /ask stores nothing
    trace_id = uuid.uuid4().hex

    def work(on_event, cancel, credentials):
        failed = {"conversation_id": None, "trace_id": trace_id, "text": "", "sources": [], "ok": False, "error": FAILED}
        try:
            answer = app.pipeline.ask(
                body.question, roles=roles, credentials=credentials, cancel=cancel, trace_id=trace_id,
                on_event=app.metrics.on_event if app.metrics else None,
            )
        except Exception:  # noqa: BLE001  (the caller sees one sentence; the log has the rest)
            logger.exception("Ask failed (trace %s).", trace_id)
            return False, cancel.is_set(), failed
        if app.metrics:
            app.metrics.turn_done(answer)
        if not answer.ok:
            logger.warning("Ask gave no answer (trace %s).", trace_id)
            return False, False, failed
        reply = {
            "conversation_id": None, "trace_id": trace_id, "text": answer.text,
            "sources": _sources(answer), "ok": True,
        }
        return True, False, reply

    state = app.runs.get(start(request, "ask", work)["run_id"])
    await state.task
    return state.result
