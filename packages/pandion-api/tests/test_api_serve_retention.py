"""Serve deletes conversations older than retention_days at startup and every day after."""

import asyncio
import logging
import time

import pytest

from apihelpers import make_serve_client
from pandion.extend import Turn
from pandion_api import ServeSettings
from pandion_api.serve import retention_loop


def old_turn():
    return Turn(question="old", answer="a", created_at="2020-01-01T00:00:00+00:00")


def test_the_sweep_runs_at_startup_and_deletes_old_conversations(tmp_path):
    from apihelpers import settings
    from pandion_api.serve import default_store

    store = default_store(settings(tmp_path))
    store.append("old", "u1", old_turn())
    store.append("new", "u1", Turn(question="n", answer="a"))
    with make_serve_client(tmp_path, store=store, serve=ServeSettings(retention_days=30), indexed=False):
        for _ in range(100):
            if store.load("old", "u1") is None:
                break
            time.sleep(0.05)
        assert store.load("old", "u1") is None and store.load("new", "u1") is not None


def test_the_sweep_repeats_daily():
    calls, sleeps = [], []

    class Store:
        def expire(self, days):
            calls.append(days)
            return 2

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(retention_loop(Store(), 30, sleep=fake_sleep))
    assert calls == [30, 30] and sleeps == [86400, 86400]


def test_a_failing_sweep_does_not_stop_the_loop(caplog):
    calls, sleeps = [], []

    class Store:
        def expire(self, days):
            calls.append(days)
            if len(calls) == 1:
                raise RuntimeError("db down")
            return 0

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise asyncio.CancelledError

    with caplog.at_level(logging.INFO), pytest.raises(asyncio.CancelledError):
        asyncio.run(retention_loop(Store(), 30, sleep=fake_sleep))
    assert len(calls) == 2
    assert any("Retention sweep failed" in r.getMessage() for r in caplog.records)


def test_the_sweep_logs_one_line_with_the_count(caplog):
    class Store:
        def expire(self, days):
            return 4

    async def fake_sleep(seconds):
        raise asyncio.CancelledError

    with caplog.at_level(logging.INFO), pytest.raises(asyncio.CancelledError):
        asyncio.run(retention_loop(Store(), 7, sleep=fake_sleep))
    assert "retention sweep: removed 4 conversations older than 7 days" in [r.getMessage() for r in caplog.records]


def test_retention_days_below_one_is_refused():
    with pytest.raises(ValueError, match="retention_days"):
        ServeSettings(retention_days=0)


def test_shutdown_cancels_the_sweep(tmp_path):
    with make_serve_client(tmp_path, indexed=False) as c:
        task = c.app.state.retention
        assert not task.done()
    assert task.done() and task.cancelled()

