"""JSON log lines: valid JSON, the ids, no user or answer text unless asked, one line per request and step."""

import io
import json
import logging

import pytest

from pandion_api.observability import JsonFormatter, configure_logging, log_content, log_event

from test_api_chat import StubPipeline, rewrites, say, serve  # noqa: F401


@pytest.fixture
def lines():
    """Everything the pandion_api logger writes, one parsed JSON object per line."""
    logger = logging.getLogger("pandion_api")
    saved = logger.handlers[:]
    logger.handlers.clear()
    stream = io.StringIO()
    configure_logging(stream=stream)

    def read():
        return [json.loads(line) for line in stream.getvalue().splitlines() if line]

    yield read
    logger.handlers[:] = saved


def test_every_log_line_is_valid_json(lines):
    logging.getLogger("pandion_api.x").warning('say "hi"\n{not: json} %s', "a\nb")
    [line] = lines()
    assert line["msg"] == 'say "hi"\n{not: json} a\nb'
    assert line["level"] == "WARNING"


def test_lines_carry_trace_id_and_conversation_id(lines):
    logging.getLogger("pandion_api.x").info(
        "hello", extra={"trace_id": "abc", "conversation_id": "c1", "stage": "answer"}
    )
    [line] = lines()
    assert (line["trace_id"], line["conversation_id"], line["stage"]) == ("abc", "c1", "answer")


def test_no_user_or_answer_text_by_default(lines, tmp_path, rewrites):
    say(serve(tmp_path, StubPipeline()), "A very private question?")
    assert lines()
    assert "private question" not in json.dumps(lines())


def test_content_appears_when_the_env_flag_is_true(lines, tmp_path, rewrites, monkeypatch):
    monkeypatch.setenv("PANDION_LOG_CONTENT", "true")
    assert log_content()
    say(serve(tmp_path, StubPipeline()), "A very private question?")
    assert "private question" in json.dumps(lines())


def test_one_request_line_per_request_with_status_and_duration(lines, tmp_path):
    serve(tmp_path).get("/health")
    [line] = [x for x in lines() if x.get("route")]
    assert (line["route"], line["method"], line["status"]) == ("/health", "GET", 200)
    assert line["duration_ms"] >= 0


def test_step_lines_come_from_executor_events(lines):
    usage = {"model": "m", "input_tokens": 3, "output_tokens": 4}
    log_event({"event": "node_finished", "stage": "answer", "duration_ms": 12.5, "trace_id": "t1", "usage": usage}, "c1")
    log_event({"event": "node_started", "stage": "answer"}, "c1")
    log_event({"event": "node_failed", "stage": "rerank", "error": "boom", "usage": None, "trace_id": "t1"}, "c1")
    done, failed = lines()
    assert (done["stage"], done["duration_ms"], done["trace_id"], done["conversation_id"]) == ("answer", 12.5, "t1", "c1")
    assert done["usage"] == usage
    assert failed["level"] == "ERROR" and failed["stage"] == "rerank"


def test_configure_logging_twice_adds_one_handler(lines):
    configure_logging()
    ours = [h for h in logging.getLogger("pandion_api").handlers if isinstance(h.formatter, JsonFormatter)]
    assert len(ours) == 1


def test_configure_logging_keeps_propagation_and_respects_existing_handlers():
    logger = logging.getLogger("pandion_api")
    saved, prop = logger.handlers[:], logger.propagate
    try:
        logger.handlers[:] = [logging.NullHandler()]
        configure_logging()
        assert not any(isinstance(h.formatter, JsonFormatter) for h in logger.handlers)
        logger.handlers.clear()
        configure_logging()
        assert logger.propagate is True
    finally:
        logger.handlers[:], logger.propagate = saved, prop
