"""POST /feedback in serve mode: the owner only, the metric, the limit, and no comment text anywhere else."""

import logging

import pytest

from apihelpers import make_serve_client
from pandion_api import Policy, ServeSettings
from test_api_chat import ByHeader, StubPipeline, say

SECRET = "my-secret-comment"
NO_TRACES = "This server's conversation store does not keep traces."


def serve(tmp_path, user="ann", **kwargs):
    client = make_serve_client(tmp_path, ByHeader(), indexed=False, **kwargs)
    client.app.state.pipeline = StubPipeline()
    client.headers["x-user"] = user
    return client


def turn(client):
    return say(client).json()["trace_id"]


def give(client, trace_id, value="up", headers=None, **extra):
    return client.post("/feedback", json={"trace_id": trace_id, "value": value, **extra}, headers=headers)


def feedback_of(client, trace_id, user="ann"):
    return client.app.state.conversations.trace(trace_id, user).feedback


def test_feedback_is_saved_for_the_owner(tmp_path):
    with serve(tmp_path) as c:
        trace_id = turn(c)
        r = give(c, trace_id, "down", category="wrong_answer", comment="It missed page 2.")
        saved = feedback_of(c, trace_id)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert [(f.value, f.category, f.comment) for f in saved] == [("down", "wrong_answer", "It missed page 2.")]


def test_feedback_on_another_users_trace_is_a_404(tmp_path):
    with serve(tmp_path) as c:
        trace_id = turn(c)
        r = give(c, trace_id, headers={"x-user": "bob"})
        missing = give(c, "nope", headers={"x-user": "bob"})
        assert feedback_of(c, trace_id) == []
    assert r.status_code == 404 and r.json() == missing.json()


@pytest.mark.parametrize("extra", [{"value": "meh"}, {"category": "x" * 41}, {"comment": "y" * 501}])
def test_feedback_bad_input_is_422_without_echoing_it(tmp_path, extra):
    with serve(tmp_path) as c:
        r = give(c, turn(c), **extra)
    assert r.status_code == 422 and ("y" * 501) not in r.text and ("x" * 41) not in r.text


def test_feedback_without_trace_support_is_501_with_a_sentence(tmp_path):
    class Plain:
        """A conversation store with no trace support."""

        def __init__(self, inner):
            self.inner = inner

        def __getattr__(self, name):
            if name in ("save_trace", "trace", "traces", "add_feedback", "save_scores"):
                raise AttributeError(name)
            return getattr(self.inner, name)

    with serve(tmp_path) as c:
        c.app.state.conversations = Plain(c.app.state.conversations)
        r = give(c, "t1")
    assert r.status_code == 501 and r.json()["detail"] == NO_TRACES


def test_anonymous_policy_cannot_give_feedback(tmp_path):
    with make_serve_client(tmp_path, Policy.anonymous(), indexed=False) as c:
        c.app.state.pipeline = StubPipeline()
        r = give(c, say(c).json()["trace_id"])
    assert r.status_code == 403


def metric_client(tmp_path):
    pytest.importorskip("prometheus_client")
    return serve(tmp_path, serve=ServeSettings(metrics_on_app=True))


def sample(c, name, **labels):
    return c.app.state.metrics.registry.get_sample_value(name, labels)


def test_feedback_total_counts_value_and_category(tmp_path):
    with metric_client(tmp_path) as c:
        trace_id = turn(c)
        give(c, trace_id, "down", category="wrong_answer")
        give(c, trace_id, "up")
        assert sample(c, "feedback_total", value="down", category="wrong_answer") == 1
        assert sample(c, "feedback_total", value="up", category="") == 1


@pytest.mark.parametrize("category", ["Wrong Answer!", "a/b", "user@example.com"])
def test_a_category_outside_the_pattern_becomes_other_in_the_metric(tmp_path, category):
    with metric_client(tmp_path) as c:
        assert give(c, turn(c), "down", category=category).status_code == 200
        assert sample(c, "feedback_total", value="down", category="other") == 1
        assert sample(c, "feedback_total", value="down", category=category) is None


def test_a_long_category_is_refused_and_never_a_label(tmp_path):
    with metric_client(tmp_path) as c:
        assert give(c, turn(c), "down", category="x" * 41).status_code == 422
        assert sample(c, "feedback_total", value="down", category="other") is None


def test_a_refused_feedback_counts_nothing(tmp_path):
    with metric_client(tmp_path) as c:
        give(c, "nope", "down", category="wrong_answer")
        assert sample(c, "feedback_total", value="down", category="wrong_answer") is None


def test_comment_is_not_in_metrics_or_logs(tmp_path, caplog):
    with metric_client(tmp_path) as c, caplog.at_level(logging.DEBUG):
        give(c, turn(c), "down", category="wrong_answer", comment=SECRET)
        scraped = c.get("/metrics").text
    assert SECRET not in scraped and SECRET not in caplog.text


def test_feedback_is_rate_limited_for_each_user(tmp_path):
    with serve(tmp_path, serve=ServeSettings(feedback_per_minute=2)) as c:
        trace_id = turn(c)
        codes = [give(c, trace_id).status_code for _ in range(3)]
        other = give(c, trace_id, headers={"x-user": "bob"}).status_code
    assert codes == [200, 200, 429] and other == 404


def test_feedback_route_is_mounted_in_serve_only():
    from pandion_api.app import ROUTERS
    from pandion_api.serve import SERVE_ROUTERS

    paths = lambda routers: {route.path for router in routers for route in router.routes}
    assert "/feedback" in paths(SERVE_ROUTERS) and "/feedback" not in paths(ROUTERS)
