"""POST /chat in serve mode: one chat turn, as JSON or as server-sent events.

Only the last message counts, and it must be the user's: the conversation's
history is the server's, kept in the conversation store under the Policy's
`user_id`, so a client cannot write it. The events are `chat_rewrite`,
`sources`, `token` (the whole answer in one event, because the answer step does
not stream yet), `done` and, after a failure, `error` before `done`.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, AsyncIterator, Literal

import anyio
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from pandion.chat_turn import chat_turn, fold_summary, remember
from pandion_api.jobs import start
from pandion_api.runs import event, events_response

router = APIRouter()
logger = logging.getLogger(__name__)

#: What a caller is told when a turn fails; the trace id finds the real reason in the log.
FAILED = "Sorry, that question could not be answered. Please try again."
NO_CONVERSATION = "There is no conversation with that id."


class Message(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(min_length=1, max_length=8000)


class ChatIn(BaseModel):
    #: The chat so far. Only the last message, which must be the user's, is used.
    messages: list[Message] = Field(min_length=1, max_length=50)
    #: Continue this conversation; left out, a new one starts.
    conversation_id: str | None = None
    #: True: answer as server-sent events. False: wait and answer as JSON.
    stream: bool = False


def _sources(answer: Any) -> list[dict[str, Any]]:
    """The found pieces as ids, document names, pages and scores. Never their text."""
    return [
        {
            "id": h.chunk.id,
            "document": h.chunk.doc_id,
            "pages": list(h.chunk.page_span) if h.chunk.page_span else None,
            "score": h.score,
        }
        for h in answer.hits
    ]


@router.post("/chat")
async def chat(body: ChatIn, request: Request):
    last = body.messages[-1]
    if last.role != "user":
        raise HTTPException(status_code=422, detail="The last message must be from the user.")
    app = request.app.state
    policy, store, settings = app.policy, app.conversations, app.serve.chat
    policy.limit(request)
    user_id, roles = policy.user_id(request), policy.roles(request)
    if body.conversation_id is not None:
        if await anyio.to_thread.run_sync(store.load, body.conversation_id, user_id) is None:
            raise HTTPException(status_code=404, detail=NO_CONVERSATION)
    trace_id = uuid.uuid4().hex

    def work(on_event, cancel, credentials):
        began = time.monotonic()
        failed = {"conversation_id": body.conversation_id, "trace_id": trace_id, "text": "", "sources": [], "ok": False, "error": FAILED}

        def fail():
            on_event(event("error", error=FAILED, trace_id=trace_id))
            on_event(event("done", conversation_id=body.conversation_id, trace_id=trace_id, ok=False))
            return False, cancel.is_set(), failed

        def forward(e):  # the executor's own events stay on the server
            if e.get("event") == "chat_rewrite":
                on_event(e)

        try:
            result = chat_turn(
                app.pipeline, store, user_id=user_id, question=last.content, conversation_id=body.conversation_id,
                settings=settings, roles=roles, credentials=credentials, on_event=forward, trace_id=trace_id,
                cancel=cancel,
            )
        except Exception:  # noqa: BLE001  (the caller sees one sentence; the log has the rest)
            logger.exception("Chat turn failed (trace %s).", trace_id)
            return fail()
        if not result.answer.ok:
            logger.warning("Chat turn gave no answer (trace %s).", trace_id)
            return fail()
        sources = _sources(result.answer)
        on_event(event("sources", sources=sources))
        on_event(event("token", text=result.text))
        on_event(event(
            "done", conversation_id=result.conversation_id, trace_id=trace_id, ok=True,
            cost=result.answer.cost(), timings={"total_ms": round((time.monotonic() - began) * 1000)},
        ))

        def after_reply() -> None:
            try:
                fold_summary(
                    store, conversation_id=result.conversation_id, user_id=user_id, settings=settings,
                    credentials=credentials,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Summary skipped (%s).", type(exc).__name__)
            if settings.memory:
                remember(store, user_id=user_id, question=last.content, settings=settings, credentials=credentials)

        threading.Thread(target=after_reply, daemon=True).start()
        reply = {"conversation_id": result.conversation_id, "trace_id": trace_id, "text": result.text, "sources": sources, "ok": True}
        return True, False, reply

    state = app.runs.get(start(request, "chat", work)["run_id"])
    if not body.stream:
        await state.task
        return state.result
    response = events_response(state, 0)
    inner = response.body_iterator

    async def until_disconnect() -> AsyncIterator[str]:
        try:
            async for chunk in inner:
                yield chunk
        finally:
            if not state.done:  # the client left: stop the turn, so it stores nothing
                app.runs.cancel(state)

    response.body_iterator = until_disconnect()
    return response
