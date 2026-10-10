"""The deploy check: wait for the Space to run the commit just published, then check it."""

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "verify_space", Path(__file__).resolve().parents[1] / "scripts" / "verify_space.py"
)
vs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vs)


def test_the_space_host_follows_hugging_faces_naming():
    assert vs.space_host("nadeem4nk/rag-playground") == "https://nadeem4nk-rag-playground.hf.space"
    assert vs.space_host("Nadeem4nk/rag_playground.staging") == "https://nadeem4nk-rag-playground-staging.hf.space"


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def test_waits_through_building_and_an_old_build_until_the_new_commit_answers():
    stages = iter(["BUILDING", "RUNNING", "RUNNING", "RUNNING"])
    commits = iter(["old", "old", "new"])
    clock = Clock()
    vs.wait_for_commit(lambda: next(stages), lambda: {"status": "ok", "commit": next(commits)}, "new", timeout=600, interval=10, now=clock.now, sleep=clock.sleep)
    assert clock.t == 30


def test_a_build_error_fails_at_once():
    clock = Clock()
    with pytest.raises(vs.DeployFailed, match="BUILD_ERROR"):
        vs.wait_for_commit(lambda: "BUILD_ERROR", lambda: {}, "new", timeout=600, interval=10, now=clock.now, sleep=clock.sleep)
    assert clock.t == 0


def test_a_runtime_error_fails_too():
    clock = Clock()
    with pytest.raises(vs.DeployFailed, match="RUNTIME_ERROR"):
        vs.wait_for_commit(lambda: "RUNTIME_ERROR", lambda: {}, "new", timeout=600, interval=10, now=clock.now, sleep=clock.sleep)


def test_gives_up_after_the_timeout_and_says_what_it_last_saw():
    clock = Clock()
    with pytest.raises(vs.DeployFailed, match="still running commit old"):
        vs.wait_for_commit(lambda: "RUNNING", lambda: {"status": "ok", "commit": "old"}, "new", timeout=60, interval=10, now=clock.now, sleep=clock.sleep)


def test_a_health_check_that_cannot_connect_yet_is_retried():
    clock = Clock()
    answers = iter([OSError("connection refused"), {"status": "ok", "commit": "new"}])

    def health():
        a = next(answers)
        if isinstance(a, Exception):
            raise a
        return a

    vs.wait_for_commit(lambda: "RUNNING", health, "new", timeout=600, interval=10, now=clock.now, sleep=clock.sleep)
    assert clock.t == 10


def test_a_clip_must_be_a_real_file_not_an_lfs_pointer():
    vs.check_clip(856_726)
    with pytest.raises(vs.DeployFailed, match="LFS pointer"):
        vs.check_clip(131)
