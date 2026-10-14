"""RunManager: background runs, each with its event log, for the SSE stream.

A run's work is synchronous and CPU-bound (a Pandion pipeline), so it runs in a
worker thread via `anyio.to_thread.run_sync`. Its events fire on that thread
and are marshalled onto the event loop with `loop.call_soon_threadsafe`, which
runs them in order, so the log changes only on the loop thread, in exactly the
order the run emitted them.

Each run keeps its whole event log. A subscriber (an SSE client) gets the log
from the position it asks for, then live events, so a reconnect, or a
subscribe after the run ended, sees every event. The manager adds a last event
of its own, `stream_end`, so every stream ends with one, even a run that
crashed.

A run is stopped through its `cancel`, a `threading.Event`, which Pandion's
`cancel=` takes as it is: the step that is running finishes and no other
starts. With a limit (`Policy.max_active_runs`), runs past it wait in arrival
order: a waiting run logs `queued` (with how many wait ahead of it), then
`unqueued` when its turn comes. Cancelling a waiting run ends it unrun.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import traceback
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

import anyio
from fastapi.responses import JSONResponse, StreamingResponse

#: Publishes one event. Called from the worker thread.
Emit = Callable[[dict[str, Any]], None]

#: The work a run does in a worker thread, given the emit and the run's cancel
#: event. Returns (ok, cancelled), or (ok, cancelled, result) with a plain JSON result.
Job = Callable[[Emit, threading.Event], tuple]

#: Seconds between SSE comment heartbeats on an idle stream.
HEARTBEAT_S = 15.0

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def event(kind: str, **fields: Any) -> dict[str, Any]:
    """One event, shaped as Pandion's executor shapes its own: plain JSON with a time."""
    return {"event": kind, "ts": time.time(), **fields}


@dataclass
class RunState:
    run_id: str
    kind: str
    status: str = "running"  # running | finished | cancelled | error
    ok: bool | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = None
    #: Set to stop the run between steps (see the module note).
    cancel: threading.Event = field(default_factory=threading.Event)
    #: What the job returned as its result, plain JSON, once it ended.
    result: Any = None
    #: Who started the run, as the site's `Policy.run_owner` names them. None: anyone.
    owner: str | None = None

    @property
    def cancel_requested(self) -> bool:
        return self.cancel.is_set()

    @cancel_requested.setter
    def cancel_requested(self, value: bool) -> None:
        if value:
            self.cancel.set()
        else:
            self.cancel.clear()

    @property
    def done(self) -> bool:
        return self.status != "running"

    def snapshot(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "kind": self.kind,
            "status": self.status,
            "ok": self.ok,
            "cancel_requested": self.cancel_requested,
            "last_event_id": len(self.events) - 1,
            "events": list(self.events),
        }


@dataclass
class _Turn:
    """A waiting run's place in line: set when its slot comes, or when it is cancelled."""

    event: asyncio.Event = field(default_factory=asyncio.Event)
    granted: bool = False


class RunManager:
    """Runs jobs on worker threads, at most `limit()` at once (None: no limit).
    With a limit, runs past it wait in arrival
    order: a waiting run logs `queued` (with how many wait ahead of it), then
    `unqueued` when it gets its turn. Cancelling a waiting run ends it unrun."""

    def __init__(self, limit: Callable[[], int | None] = lambda: None) -> None:
        self.runs: dict[str, RunState] = {}
        self._limit = limit
        self._working = 0
        self._waiting: deque[tuple[RunState, _Turn]] = deque()

    def get(self, run_id: str) -> RunState | None:
        return self.runs.get(run_id)

    def active(self) -> list[RunState]:
        return [s for s in self.runs.values() if not s.done]

    def _publish(self, state: RunState, e: dict[str, Any]) -> None:
        """Loop thread only: append to the log and fan out to subscribers."""
        state.events.append(e)
        seq = len(state.events) - 1
        for q in state.subscribers:
            q.put_nowait((seq, e))

    def start(
        self, kind: str, job: Job, owner: str | None = None, scrub: Callable[[str], str] | None = None
    ) -> RunState:
        """Schedule `job` on a worker thread. Must be called on the event loop.
        `scrub` takes what may not leave the server out of a crash's traceback
        before it is logged as `run_error`."""
        loop = asyncio.get_running_loop()
        state = RunState(run_id=uuid.uuid4().hex, kind=kind, owner=owner)
        self.runs[state.run_id] = state

        def on_event(e: dict[str, Any]) -> None:  # worker thread
            loop.call_soon_threadsafe(self._publish, state, e)

        async def main() -> None:
            if not await self._take_turn(state):
                state.ok, state.status = False, "cancelled"
                self._publish(state, event("stream_end", status="cancelled", ok=False))
                return
            try:
                ok, was_cancelled, *rest = await anyio.to_thread.run_sync(
                    job, on_event, state.cancel
                )
                state.result = rest[0] if rest else None
                status = "cancelled" if was_cancelled else "finished"
                error = None
            except Exception:
                error = traceback.format_exc()
                ok, status, error = False, "error", scrub(error) if scrub else error
                self._publish(state, event("run_error", error=error))
            finally:
                self._end_turn()
            # Every call_soon_threadsafe from the job was queued before the
            # thread's completion was, so the log is complete at this point.
            state.ok, state.status = ok, status
            self._publish(state, event("stream_end", status=status, ok=ok))

        state.task = loop.create_task(main())
        return state

    async def _take_turn(self, state: RunState) -> bool:
        """Wait for a free slot when the limit is reached. False if the run was cancelled while waiting."""
        limit = self._limit()
        if limit is None or (self._working < limit and not self._waiting):
            self._working += 1
            return True
        turn = _Turn()
        self._waiting.append((state, turn))
        self._publish(state, event("queued", ahead=len(self._waiting) - 1))
        await turn.event.wait()
        if state.cancel_requested:
            if turn.granted:
                self._end_turn()  # cancelled after its slot came: pass the slot on
            return False
        self._publish(state, event("unqueued"))
        return True

    def _end_turn(self) -> None:
        """Hand the slot to the next run in line, or free it."""
        if self._waiting:
            _, turn = self._waiting.popleft()
            turn.granted = True
            turn.event.set()
            return
        self._working -= 1

    def cancel(self, state: RunState) -> None:
        state.cancel_requested = True
        for i, (waiting, turn) in enumerate(self._waiting):
            if waiting is state:
                del self._waiting[i]
                turn.event.set()  # it ends unrun, holding no slot
                break

    async def shutdown(self) -> None:
        """Ask every live run to stop at its next node boundary, then wait."""
        tasks = [s.task for s in self.active() if s.task]
        for s in self.active():
            s.cancel_requested = True
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def start_at(last_event_id: str | None, resume_after: str | None) -> int:
    """The first event to send: after `Last-Event-ID`, else after
    `?last_event_id=N`, else from the start. The header wins: it comes from the
    browser's own, more recent, reconnect."""
    resume = last_event_id if last_event_id is not None else resume_after
    try:
        start = int(resume) + 1 if resume is not None else 0
    except ValueError:
        start = 0
    return max(start, 0)


def _frame(seq: int, e: dict[str, Any]) -> str:
    # json.dumps escapes newlines, so one event is always one `data:` line.
    return f"id: {seq}\ndata: {json.dumps(e)}\n\n"


def events_response(state: RunState, start: int) -> StreamingResponse:
    """The run's events from `start` as server-sent events, then live ones to `stream_end`."""

    async def stream() -> AsyncIterator[str]:
        # Snapshot the backlog and subscribe with no await in between: the log
        # changes only on this loop, so no event can fall into a gap.
        backlog = list(enumerate(state.events))[start:]
        q: asyncio.Queue = asyncio.Queue()
        if not state.done:
            state.subscribers.add(q)
        try:
            for seq, e in backlog:
                yield _frame(seq, e)
            if state.done:
                return
            while True:
                try:
                    seq, e = await asyncio.wait_for(q.get(), HEARTBEAT_S)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield _frame(seq, e)
                if e["event"] == "stream_end":
                    return
        finally:
            state.subscribers.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)


def cancel_response(manager: RunManager, state: RunState) -> JSONResponse | dict[str, Any]:
    """Ask a run to stop: 409 when it already ended, else the request is noted."""
    if state.done:
        return JSONResponse(
            status_code=409,
            content={"detail": f"run already {state.status}", "status": state.status},
        )
    manager.cancel(state)
    return {
        "run_id": state.run_id,
        "cancel_requested": True,
        "detail": (
            "Cancellation is checked between nodes: the node currently running "
            "will finish, and no further nodes will start."
        ),
    }
