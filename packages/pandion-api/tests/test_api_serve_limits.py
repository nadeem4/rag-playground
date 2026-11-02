"""Serve's default limits: turns a minute, active turns, body size and the turn deadline."""

import pytest
from fastapi import HTTPException

from apihelpers import make_serve_client
from pandion_api import ServeSettings
from pandion_api.limits import TurnLimiter
from test_api_chat import Policy, StubPipeline, answer, say
from test_api_serve_errors import Boom


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


def client(tmp_path, stub, policy=None, **limits):
    c = make_serve_client(tmp_path, policy, indexed=False, serve=ServeSettings(**limits))
    c.app.state.pipeline = stub
    return c


def test_defaults_are_on():
    s = ServeSettings()
    assert (s.turns_per_minute, s.active_turns_per_user, s.max_body_bytes, s.turn_deadline_s) == (20, 2, 65536, 120.0)


def test_the_21st_turn_in_a_minute_is_a_429():
    limiter = TurnLimiter(20, 2, clock=Clock())
    for _ in range(20):
        limiter.acquire("ann")
        limiter.release("ann")
    with pytest.raises(HTTPException) as caught:
        limiter.acquire("ann")
    assert caught.value.status_code == 429 and "too fast" in caught.value.detail


def test_the_window_slides():
    clock = Clock()
    limiter = TurnLimiter(1, 2, clock=clock)
    limiter.acquire("ann")
    limiter.release("ann")
    clock.now = 61
    limiter.acquire("ann")


def test_a_third_active_turn_is_a_429_and_a_finished_one_frees_a_slot():
    limiter = TurnLimiter(100, 2, clock=Clock())
    limiter.acquire("ann")
    limiter.acquire("ann")
    with pytest.raises(HTTPException) as caught:
        limiter.acquire("ann")
    assert caught.value.status_code == 429
    limiter.release("ann")
    limiter.acquire("ann")


def test_limits_are_per_user():
    limiter = TurnLimiter(1, 1, clock=Clock())
    limiter.acquire("ann")
    limiter.acquire("bob")


def test_the_route_answers_429_past_the_rate(tmp_path):
    with client(tmp_path, StubPipeline(), turns_per_minute=2) as c:
        assert [say(c).status_code for _ in range(3)] == [200, 200, 429]


def test_a_failed_turn_releases_its_slot(tmp_path):
    with client(tmp_path, Boom(), active_turns_per_user=1) as c:
        assert [say(c).status_code for _ in range(3)] == [200, 200, 200]


def test_an_oversize_body_is_a_413_before_parsing(tmp_path):
    with client(tmp_path, StubPipeline(), max_body_bytes=200) as c:
        r = c.post("/chat", content=b"x" * 500, headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_a_chunked_oversize_body_is_a_413(tmp_path):
    def chunks():
        for _ in range(10):
            yield b'{"messages": [' + b" " * 100

    with client(tmp_path, StubPipeline(), max_body_bytes=200) as c:
        r = c.post("/chat", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_a_turn_past_its_deadline_is_cancelled(tmp_path):
    class Slow(StubPipeline):
        def ask(self, question, **kwargs):
            kwargs["cancel"].wait(5)
            return answer(ok=False)

    with client(tmp_path, Slow(), turn_deadline_s=0.2) as c:
        r = say(c)
    assert r.json()["ok"] is False and "Something went wrong" in r.json()["error"]


def test_idle_users_are_forgotten():
    clock = Clock()
    limiter = TurnLimiter(5, 2, clock=clock)
    limiter.acquire("ann")
    limiter.release("ann")
    clock.now = 61
    limiter.acquire("bob")
    limiter.release("bob")
    assert "ann" not in limiter._times and "ann" not in limiter._active
