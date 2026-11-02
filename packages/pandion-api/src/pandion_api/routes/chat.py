"""POST /chat in serve mode: one chat turn, as JSON or as server-sent events.

Only the last message counts, and it must be the user's: the conversation's
history is the server's, kept in the conversation store under the Policy's
`user_id`, so a client cannot write it. The events are `chat_rewrite`,
`sources`, `token` (the whole answer in one event, because the answer step does
not stream yet), `done` and, after a failure, `error` before `done`.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, AsyncIterator, Literal

import anyio
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from pandion.extend import ConversationNotFound, chat_turn, fold_summary, remember
from pandion_api.errors import generic
from pandion_api.jobs import start
from pandion_api.observability import TurnSpans, content_fields, log_content, log_event
from pandion_api.runs import event, events_response

router = APIRouter()
logger = logging.getLogger(__name__)

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
    app = request.app.state
    policy, store, settings = app.policy, app.conversations, app.serve.chat
    policy.limit(request)
    last = body.messages[-1]
    if last.role != "user":
        raise HTTPException(status_code=422, detail="The last message must be from the user.")
    user_id, roles = policy.user_id(request), policy.roles(request)
    if body.conversation_id is not None:
        if await anyio.to_thread.run_sync(store.load, body.conversation_id, user_id) is None:
            raise HTTPException(status_code=404, detail=NO_CONVERSATION)
    trace_id = request.state.trace_id
    spans = TurnSpans(app.tracer, trace_id, log_content(), last.content) if app.tracer else None

    def work(on_event, cancel, credentials):
        began = time.monotonic()
        failed = {
            "conversation_id": body.conversation_id, "trace_id": trace_id, "text": "", "sources": [], "ok": False,
            "error": generic(trace_id),
        }

        def fail():
            on_event(event("error", error=generic(trace_id), trace_id=trace_id))
            on_event(event("done", conversation_id=body.conversation_id, trace_id=trace_id, ok=False))
            return False, cancel.is_set(), failed

        def forward(e):  # the executor's own events go to the log and the spans, not the client
            log_event(e, body.conversation_id)
            if spans:
                spans.on_event(e)
            if e.get("event") == "chat_rewrite":
                on_event(e)

        try:
            result = chat_turn(
                app.pipeline, store, user_id=user_id, question=last.content, conversation_id=body.conversation_id,
                settings=settings, roles=roles, credentials=credentials, on_event=forward, trace_id=trace_id,
                cancel=cancel,
            )
        except ConversationNotFound:  # it vanished after the check above
            fail()
            return False, False, {"not_found": True}
        except Exception:  # noqa: BLE001  (the caller sees one sentence; the log has the rest)
            logger.exception("Chat turn failed.", extra={"trace_id": trace_id})
            return fail()
        if not result.answer.ok:
            logger.warning("Chat turn gave no answer.", extra={"trace_id": trace_id})
            return fail()
        logger.info(
            "Chat turn answered.",
            extra={"trace_id": trace_id, "conversation_id": result.conversation_id,
                   **content_fields(question=last.content, answer=result.text)},
        )
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
                try:
                    remember(store, user_id=user_id, question=last.content, settings=settings, credentials=credentials)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Memory skipped (%s).", type(exc).__name__)

        # Tracked, so serve's shutdown waits for it instead of cutting a write.
        thread = threading.Thread(target=lambda: (after_reply(), app.background.discard(thread)), daemon=True)
        app.background.add(thread)
        thread.start()
        reply = {"conversation_id": result.conversation_id, "trace_id": trace_id, "text": result.text, "sources": sources, "ok": True}
        return True, False, reply

    def traced(on_event, cancel, credentials):
        ok = False
        try:
            outcome = work(on_event, cancel, credentials)
            ok = outcome[0]
            return outcome
        finally:
            if spans:
                spans.finish(ok)

    app.limiter.acquire(user_id)
    try:
        started = start(request, "chat", traced)
    except BaseException:  # refused (429): the turn never ran, so end its span
        app.limiter.release(user_id)
        if spans:
            spans.finish(False)
        raise
    state = app.runs.get(started["run_id"])
    # The slot is freed and the deadline dropped however the run ends, even one cancelled unrun.
    deadline = asyncio.get_running_loop().call_later(app.serve.turn_deadline_s, app.runs.cancel, state)

    def finished(_task) -> None:
        deadline.cancel()
        app.limiter.release(user_id)

    state.task.add_done_callback(finished)
    if not body.stream:
        await state.task
        if isinstance(state.result, dict) and state.result.get("not_found"):
            raise HTTPException(status_code=404, detail=NO_CONVERSATION)
        return state.result
    response = events_response(state, 0)
    inner = response.body_iterator

    async def until_disconnect() -> AsyncIterator[str]:
        try:
            async for chunk in inner:
                yield chunk
        finally:
            if spans:
                spans.finish(False)  # a no-op once the turn has ended
            if not state.done:  # the client left: stop the turn, so it stores nothing
                app.runs.cancel(state)

    response.body_iterator = until_disconnect()
    return response
