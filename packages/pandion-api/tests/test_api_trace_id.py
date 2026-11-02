"""One trace id per request: header, events, log, error and stored turn all show the same one."""

import re

import pandion_api.routes.chat as chat_route
from test_api_chat import StubPipeline, events_of, rewrites, say, serve  # noqa: F401


def test_every_response_has_an_x_trace_id_header(tmp_path):
    r = serve(tmp_path).get("/health")
    assert re.fullmatch(r"[0-9a-f]{32}", r.headers["x-trace-id"])


def test_an_incoming_trace_id_header_is_ignored(tmp_path):
    r = serve(tmp_path).get("/health", headers={"X-Trace-Id": "evil"})
    assert r.headers["x-trace-id"] != "evil"


def test_two_requests_get_two_ids(tmp_path):
    client = serve(tmp_path)
    assert client.get("/health").headers["x-trace-id"] != client.get("/health").headers["x-trace-id"]


def test_the_same_id_is_in_the_done_event_the_log_the_error_and_the_stored_turn(tmp_path, rewrites, monkeypatch):
    logged = []
    monkeypatch.setattr(chat_route.logger, "warning", lambda msg, *a, **kw: logged.append(kw.get("extra", {})))
    client = serve(tmp_path, StubPipeline())
    r = say(client)
    assert r.json()["trace_id"] == r.headers["x-trace-id"]
    turn = client.app.state.conversations.load(r.json()["conversation_id"], "anonymous").turns[-1]
    assert turn.trace_id == r.headers["x-trace-id"]
    streamed = say(client, stream=True)
    done = [e for e in events_of(streamed.text) if e["event"] == "done"][0]
    assert done["trace_id"] == streamed.headers["x-trace-id"]
    failing = serve(tmp_path, StubPipeline(ok=False))
    bad = say(failing)
    assert bad.json()["trace_id"] == bad.headers["x-trace-id"]
    assert bad.headers["x-trace-id"] in [x.get("trace_id") for x in logged]


def test_executor_events_carry_the_trace_id_and_stage(tmp_path, rewrites, monkeypatch):
    seen = []
    monkeypatch.setattr(chat_route, "log_event", lambda e, conversation_id=None: seen.append(e))

    class Stepping(StubPipeline):
        def ask(self, question, **kwargs):
            kwargs["on_event"]({"event": "node_finished", "stage": "answer", "trace_id": kwargs["trace_id"]})
            return super().ask(question, **kwargs)

    r = say(serve(tmp_path, Stepping()))
    steps = [e for e in seen if "stage" in e]
    assert steps, "no step events reached the log hook"
    assert all(e["trace_id"] == r.headers["x-trace-id"] for e in steps)
