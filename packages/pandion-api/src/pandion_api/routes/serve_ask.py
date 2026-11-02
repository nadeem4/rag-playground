"""POST /ask in serve mode: one question, one answer, nothing stored.

It is /chat without a conversation: no history, no rewrite, no summary, no memory.
The reply has the same shape as /chat's JSON reply, with `conversation_id` null.
"""

from __future__ import annotations

import logging
import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from pandion_api.jobs import start
from pandion_api.errors import generic
from pandion_api.routes.chat import _sources

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
    user_id = policy.user_id(request)  # so a Policy can refuse the caller (401); /ask stores nothing
    trace_id = request.state.trace_id

    def work(on_event, cancel, credentials):
        failed = {"conversation_id": None, "trace_id": trace_id, "text": "", "sources": [], "ok": False, "error": generic(trace_id)}
        try:
            answer = app.pipeline.ask(
                body.question, roles=roles, credentials=credentials, cancel=cancel, trace_id=trace_id
            )
        except Exception:  # noqa: BLE001  (the caller sees one sentence; the log has the rest)
            logger.exception("Ask failed (trace %s).", trace_id)
            return False, cancel.is_set(), failed
        if not answer.ok:
            logger.warning("Ask gave no answer (trace %s).", trace_id)
            return False, False, failed
        reply = {
            "conversation_id": None, "trace_id": trace_id, "text": answer.text,
            "sources": _sources(answer), "ok": True,
        }
        return True, False, reply

    app.limiter.acquire(user_id)
    try:
        state = app.runs.get(start(request, "ask", work)["run_id"])
    except BaseException:
        app.limiter.release(user_id)
        raise
    deadline = asyncio.get_running_loop().call_later(app.serve.turn_deadline_s, app.runs.cancel, state)

    def finished(_task) -> None:
        deadline.cancel()
        app.limiter.release(user_id)

    state.task.add_done_callback(finished)
    await state.task
    return state.result
