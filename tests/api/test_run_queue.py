"""The demo's run queue: at most a few runs do heavy work at once; the rest wait their turn."""

from __future__ import annotations

import asyncio
import threading

from api.runs import RunManager


def _blocking_job(gate: threading.Event, started: list[str], name: str):
    def job(emit, cancelled):
        started.append(name)
        gate.wait(5)
        return True, False

    return job


def _kinds(state) -> list[str]:
    return [e["event"] for e in state.events]


def test_runs_past_the_limit_wait_in_order_and_say_so():
    async def scenario():
        manager = RunManager(limit=lambda: 2)
        gates = [threading.Event() for _ in range(3)]
        started: list[str] = []
        a = manager.start("run", _blocking_job(gates[0], started, "a"))
        b = manager.start("run", _blocking_job(gates[1], started, "b"))
        c = manager.start("run", _blocking_job(gates[2], started, "c"))
        await asyncio.sleep(0.2)
        assert sorted(started) == ["a", "b"]
        assert _kinds(c) == ["queued"]
        # Nobody waits in front of it.
        assert c.events[0]["ahead"] == 0
        assert "queued" not in _kinds(a) and "queued" not in _kinds(b)
        gates[0].set()
        await asyncio.sleep(0.3)
        assert started[-1] == "c"
        assert _kinds(c)[:2] == ["queued", "unqueued"]
        gates[1].set()
        gates[2].set()
        await asyncio.gather(a.task, b.task, c.task)
        assert [s.status for s in (a, b, c)] == ["finished"] * 3

    asyncio.run(scenario())


def test_a_waiting_run_that_is_cancelled_ends_without_running():
    async def scenario():
        manager = RunManager(limit=lambda: 1)
        gate = threading.Event()
        started: list[str] = []
        a = manager.start("run", _blocking_job(gate, started, "a"))
        b = manager.start("run", _blocking_job(threading.Event(), started, "b"))
        await asyncio.sleep(0.2)
        manager.cancel(b)
        await asyncio.wait_for(b.task, 2)
        assert b.status == "cancelled" and started == ["a"]
        assert _kinds(b)[-1] == "stream_end"
        gate.set()
        await a.task

    asyncio.run(scenario())


def test_no_limit_runs_everything_at_once():
    async def scenario():
        manager = RunManager(limit=lambda: None)
        gates = [threading.Event() for _ in range(4)]
        started: list[str] = []
        runs = [manager.start("run", _blocking_job(g, started, str(i))) for i, g in enumerate(gates)]
        await asyncio.sleep(0.3)
        assert len(started) == 4
        for g in gates:
            g.set()
        await asyncio.gather(*(r.task for r in runs))

    asyncio.run(scenario())


def test_the_demo_allows_two_runs_at_once_and_a_local_run_has_no_limit(monkeypatch):
    from api import demo
    from api.runs import demo_run_limit

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert demo_run_limit() == demo.MAX_ACTIVE_RUNS == 2
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    assert demo_run_limit() is None


def test_a_run_cancelled_just_as_its_turn_comes_passes_the_slot_on():
    async def scenario():
        manager = RunManager(limit=lambda: 1)
        gates = [threading.Event() for _ in range(3)]
        started: list[str] = []
        a = manager.start("run", _blocking_job(gates[0], started, "a"))
        b = manager.start("run", _blocking_job(gates[1], started, "b"))
        c = manager.start("run", _blocking_job(gates[2], started, "c"))
        await asyncio.sleep(0.2)
        # b's slot comes and b is cancelled in the same tick, before it can start.
        b.cancel_requested = True
        gates[0].set()
        await asyncio.wait_for(b.task, 2)
        await asyncio.sleep(0.3)
        assert b.status == "cancelled"
        assert started == ["a", "c"]
        gates[2].set()
        await asyncio.wait_for(c.task, 2)

    asyncio.run(scenario())
