"""Serve shows one generic sentence and a trace id; the detail goes to the log."""

import logging
import re

from fastapi import HTTPException
from fastapi.testclient import TestClient

from apihelpers import make_serve_client
from pandion_api import Policy
from test_api_chat import StubPipeline, events_of, say, serve

LEAK = "C:/secret/path/model.bin sk-live-123"


class Boom(StubPipeline):
    def ask(self, question, **kwargs):
        raise RuntimeError(LEAK)


def trace_in(text):
    return re.search(r"help: ([0-9a-f]{32})", text).group(1)


def test_a_crash_in_the_pipeline_shows_no_traceback_or_path(tmp_path):
    with serve(tmp_path, Boom()) as c:
        r = say(c)
    assert "Something went wrong" in r.text
    assert "secret" not in r.text and "sk-live" not in r.text and "Traceback" not in r.text


def test_the_log_holds_the_detail_and_the_trace_id(tmp_path, caplog):
    with caplog.at_level(logging.ERROR, logger="pandion_api"):
        with serve(tmp_path, Boom()) as c:
            body = say(c).json()
    logged = [r for r in caplog.records if getattr(r, "trace_id", None) == body["trace_id"] and r.exc_info]
    assert logged and LEAK in str(logged[0].exc_info[1])


def test_the_trace_id_in_the_body_matches_the_log(tmp_path, caplog):
    with caplog.at_level(logging.ERROR, logger="pandion_api"):
        with serve(tmp_path, Boom()) as c:
            body = say(c).json()
    assert trace_in(body["error"]) == body["trace_id"]
    assert any(getattr(r, "trace_id", None) == body["trace_id"] for r in caplog.records)


def test_an_unhandled_exception_is_a_generic_500(tmp_path, caplog):
    class Broken:
        def load(self, *a, **k):
            raise RuntimeError(LEAK)

    with caplog.at_level(logging.ERROR, logger="pandion_api"):
        with make_serve_client(tmp_path, store=Broken()) as c:
            client = TestClient(c.app, raise_server_exceptions=False)
            r = client.post("/chat", json={"messages": [{"role": "user", "content": "Hi"}], "conversation_id": "x"})
    assert r.status_code == 500 and "Something went wrong" in r.text and "secret" not in r.text
    assert any(getattr(rec, "trace_id", None) == trace_in(r.text) for rec in caplog.records)


def test_a_policy_http_exception_keeps_its_sentence(tmp_path):
    class Full(Policy):
        def user_id(self, request):
            return "ann"

        def roles(self, request):
            return None

        def limit(self, request):
            raise HTTPException(status_code=429, detail="Too many questions. Try again later.")

    with serve(tmp_path, StubPipeline(), Full()) as c:
        r = say(c)
    assert r.status_code == 429 and r.json()["detail"] == "Too many questions. Try again later."


def test_stream_errors_are_generic_too(tmp_path, monkeypatch):
    def crash(answer):
        raise RuntimeError(LEAK)

    monkeypatch.setattr("pandion_api.routes.chat._sources", crash)
    with serve(tmp_path, StubPipeline()) as c:
        r = say(c, stream=True)
    events = events_of(r.text)
    assert any(e["event"] == "run_error" and "Something went wrong" in e["error"] for e in events)
    assert "secret" not in r.text and "Traceback" not in r.text


def test_lab_errors_are_unchanged(tmp_path, monkeypatch):
    from apihelpers import make_client

    with make_client(tmp_path) as c:
        r = c.get("/runs/nope")
    assert r.status_code == 404 and "Something went wrong" not in r.text


def test_the_500_body_trace_id_equals_the_header_and_the_log(tmp_path, caplog):
    class Broken:
        def load(self, *a, **k):
            raise RuntimeError(LEAK)

    with caplog.at_level(logging.ERROR, logger="pandion_api"):
        with make_serve_client(tmp_path, store=Broken()) as c:
            client = TestClient(c.app, raise_server_exceptions=False)
            r = client.post("/chat", json={"messages": [{"role": "user", "content": "Hi"}], "conversation_id": "x"})
    assert r.status_code == 500
    assert trace_in(r.json()["detail"]) == r.headers["x-trace-id"]
    assert any(getattr(rec, "trace_id", None) == r.headers["x-trace-id"] for rec in caplog.records)


def test_a_run_error_uses_the_request_trace_id(tmp_path, monkeypatch):
    monkeypatch.setattr("pandion_api.routes.chat._sources", lambda a: (_ for _ in ()).throw(RuntimeError(LEAK)))
    with serve(tmp_path, StubPipeline()) as c:
        r = say(c, stream=True)
    err = next(e for e in events_of(r.text) if e["event"] == "run_error")
    assert trace_in(err["error"]) == r.headers["x-trace-id"]
