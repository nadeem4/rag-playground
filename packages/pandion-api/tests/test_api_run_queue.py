"""The run queue: past a policy's limit, runs wait their turn; cancel is a threading.Event."""

from __future__ import annotations

import asyncio
import threading

from pandion_api.runs import RunManager, RunState, events_response, start_at


def _blocking_job(gate: threading.Event, started: list[str], name: str):
    def job(emit, cancel):
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


def test_cancel_is_a_threading_event_a_pipeline_can_take():
    async def scenario():
        manager = RunManager(limit=lambda: None)
        seen: list[bool] = []

        def job(emit, cancel):
            seen.append(cancel.wait(2))
            return True, cancel.is_set(), {"stopped": cancel.is_set()}

        state = manager.start("run", job)
        await asyncio.sleep(0.1)
        manager.cancel(state)
        await asyncio.wait_for(state.task, 3)
        assert seen == [True]
        assert state.cancel_requested is True and state.status == "cancelled"
        assert state.result == {"stopped": True}

    asyncio.run(scenario())


def test_a_job_without_a_result_leaves_none():
    async def scenario():
        manager = RunManager(limit=lambda: None)
        state = manager.start("run", lambda emit, cancel: (True, False))
        await asyncio.wait_for(state.task, 2)
        assert state.status == "finished" and state.result is None

    asyncio.run(scenario())


def test_the_stream_starts_after_the_last_event_id():
    assert start_at(None, None) == 0
    assert start_at("4", None) == 5
    assert start_at(None, "2") == 3
    assert start_at("4", "2") == 5  # the header wins
    assert start_at("x", None) == 0 and start_at("-9", None) == 0


def test_a_finished_runs_stream_replays_its_log_from_the_start_asked():
    async def scenario():
        state = RunState(run_id="r", kind="run", status="finished")
        state.events = [{"event": "a"}, {"event": "stream_end"}]
        response = events_response(state, 1)
        chunks = [chunk async for chunk in response.body_iterator]
        assert chunks == ['id: 1\ndata: {"event": "stream_end"}\n\n']

    asyncio.run(scenario())


def test_a_run_remembers_who_started_it():
    """The owner a site's Policy names (`Policy.run_owner`), so a later route can
    keep one visitor from reading or cancelling another's run."""

    async def scenario():
        manager = RunManager(limit=lambda: None)
        mine = manager.start("run", lambda emit, cancel: (True, False), owner="visitor-a")
        anyones = manager.start("run", lambda emit, cancel: (True, False))
        await asyncio.gather(mine.task, anyones.task)
        assert mine.owner == "visitor-a" and anyones.owner is None

    asyncio.run(scenario())


# --- finished runs are not kept forever ----------------------------------------


class _Clock:
    """A clock a test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _quick(emit, cancel):
    return True, False


def test_a_finished_run_is_dropped_an_hour_after_it_ended():
    async def scenario():
        clock = _Clock()
        manager = RunManager(clock=clock)
        done = manager.start("run", _quick)
        await done.task
        clock.now += 3599
        assert manager.get(done.run_id) is done
        clock.now += 2
        assert manager.get(done.run_id) is None
        assert done.run_id not in manager.runs

    asyncio.run(scenario())


def test_an_active_or_queued_run_is_never_dropped_however_old():
    async def scenario():
        clock = _Clock()
        manager = RunManager(limit=lambda: 1, clock=clock, keep_finished=0)
        gate = threading.Event()
        working = manager.start("run", _blocking_job(gate, [], "a"))
        waiting = manager.start("run", _blocking_job(threading.Event(), [], "b"))
        await asyncio.sleep(0.2)
        clock.now += 10 * 3600
        assert manager.get(working.run_id) is working
        assert manager.get(waiting.run_id) is waiting
        manager.cancel(waiting)
        gate.set()
        await asyncio.gather(working.task, waiting.task)

    asyncio.run(scenario())


def test_at_most_the_newest_finished_runs_are_kept_oldest_dropped_first():
    async def scenario():
        clock = _Clock()
        manager = RunManager(clock=clock, keep_finished=3)
        runs = []
        for _ in range(5):
            state = manager.start("run", _quick)
            await state.task
            clock.now += 1
            runs.append(state)
        kept = [s for s in runs if manager.get(s.run_id) is not None]
        assert kept == runs[2:]

    asyncio.run(scenario())


def test_by_default_two_hundred_finished_runs_are_kept():
    async def scenario():
        clock = _Clock()
        manager = RunManager(clock=clock)
        runs = []
        for _ in range(201):
            state = manager.start("run", _quick)
            await state.task
            clock.now += 0.001
            runs.append(state)
        assert manager.get(runs[0].run_id) is None
        assert all(manager.get(s.run_id) is s for s in runs[1:])

    asyncio.run(scenario())
