"""RunManager: background execution and the per-run event log.

`core.executor.run` is synchronous and CPU-bound, so it runs in a worker thread
via `anyio.to_thread.run_sync`. Its `on_event` callback therefore fires on that
worker thread, and is marshalled onto the event loop with
`loop.call_soon_threadsafe`. The loop processes those callbacks in FIFO order,
so the log is mutated only on the loop thread, in exactly emission order.

Each run keeps its **full** event log. A subscriber (SSE client) gets the log
from the position it asks for, then live events, which is what makes reconnect
and subscribe-after-completion work. The manager appends one final event of its
own, `stream_end`, so a stream always has a terminal event even for a sweep
(which emits one `run_finished` per variant) or a run that crashed.
"""

from __future__ import annotations

import asyncio
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

import anyio

from core.events import Emit, event

#: The work a run performs in a worker thread. Called with the thread-side emit
#: and the cancel poll; returns (ok, cancelled).
Job = Callable[[Emit, Callable[[], bool]], tuple[bool, bool]]


@dataclass
class RunState:
    run_id: str
    kind: str
    status: str = "running"  # running | finished | cancelled | error
    ok: bool | None = None
    cancel_requested: bool = False
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = None

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


class RunManager:
    def __init__(self) -> None:
        self.runs: dict[str, RunState] = {}

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

    def start(self, kind: str, job: Job) -> RunState:
        """Schedule `job` on a worker thread. Must be called on the event loop."""
        loop = asyncio.get_running_loop()
        state = RunState(run_id=uuid.uuid4().hex, kind=kind)
        self.runs[state.run_id] = state

        def on_event(e: dict[str, Any]) -> None:  # worker thread
            loop.call_soon_threadsafe(self._publish, state, e)

        def cancelled() -> bool:  # worker thread; a bool read is atomic
            return state.cancel_requested

        async def main() -> None:
            try:
                ok, was_cancelled = await anyio.to_thread.run_sync(
                    job, on_event, cancelled
                )
                status = "cancelled" if was_cancelled else "finished"
                error = None
            except Exception:
                ok, status, error = False, "error", traceback.format_exc()
                self._publish(state, event("run_error", error=error))
            # Every call_soon_threadsafe from the job was queued before the
            # thread's completion was, so the log is complete at this point.
            state.ok, state.status = ok, status
            self._publish(state, event("stream_end", status=status, ok=ok))

        state.task = loop.create_task(main())
        return state

    def cancel(self, state: RunState) -> None:
        state.cancel_requested = True

    async def shutdown(self) -> None:
        """Ask every live run to stop at its next node boundary, then wait."""
        tasks = [s.task for s in self.active() if s.task]
        for s in self.active():
            s.cancel_requested = True
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
