"""OpenTelemetry spans: one root per turn, one child per step, GenAI attributes, no content unless asked."""

import pytest

pytest.importorskip("opentelemetry.sdk")
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from pandion_api.policy import AnonymousPolicy
from pandion_api.observability import TurnSpans
from test_api_chat import StubPipeline, rewrites, say, serve  # noqa: F401

TRACE = "0123456789abcdef0123456789abcdef"
USAGE = {"model": "claude-x", "input_tokens": 7, "output_tokens": 9}


@pytest.fixture
def exporter():
    return InMemorySpanExporter()


def turn_of(exporter, content=False, **extra):
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return TurnSpans(provider.get_tracer("t"), TRACE, content, **extra)


def run(exporter, events, ok=True, **kw):
    turn = turn_of(exporter, **kw)
    for e in events:
        turn.on_event(e)
    turn.finish(ok)
    return exporter.get_finished_spans()


def finished(stage, usage=None):
    return {"event": "node_finished", "stage": stage, "ts": 1000.0, "duration_ms": 250.0, "usage": usage}


def test_a_turn_makes_one_root_span_and_a_child_per_step(exporter):
    by = {s.name: s for s in run(exporter, [finished("rewrite"), finished("answer")])}
    assert set(by) == {"chat", "rewrite", "answer"}
    assert by["rewrite"].parent.span_id == by["chat"].context.span_id
    assert by["answer"].end_time - by["answer"].start_time == 250_000_000


def test_the_trace_id_matches_the_requests_trace_id(exporter):
    done = run(exporter, [finished("answer")])
    assert {format(s.context.trace_id, "032x") for s in done} == {TRACE}


def test_a_model_step_has_the_genai_attributes(exporter):
    step = [s for s in run(exporter, [finished("answer", USAGE)]) if s.name == "answer"][0]
    assert dict(step.attributes) == {
        "gen_ai.operation.name": "chat", "gen_ai.request.model": "claude-x",
        "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 9,
    }


def test_a_step_without_usage_has_no_genai_attributes(exporter):
    step = [s for s in run(exporter, [finished("rerank")]) if s.name == "rerank"][0]
    assert not any(k.startswith("gen_ai") for k in step.attributes)


def test_content_is_not_an_attribute_by_default(exporter):
    done = run(exporter, [finished("answer", USAGE)], question="secret question")
    assert "secret question" not in str([dict(s.attributes) for s in done])


def test_content_is_added_when_log_content_is_true(exporter):
    done = run(exporter, [finished("answer", USAGE)], content=True, question="secret question")
    assert "secret question" in str([dict(s.attributes) for s in done])


def test_a_failed_step_marks_its_span_as_an_error(exporter):
    failed = {"event": "node_failed", "stage": "answer", "ts": 1000.0, "error": "boom", "usage": None}
    done = {s.name: s for s in run(exporter, [failed], ok=False)}
    assert done["answer"].status.status_code == StatusCode.ERROR
    assert done["chat"].status.status_code == StatusCode.ERROR


def test_a_chat_request_exports_spans_under_its_trace_id(exporter, tmp_path, rewrites):
    client = serve(tmp_path, StubPipeline())
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    client.app.state.tracer = provider.get_tracer("t")
    r = say(client)
    [root] = exporter.get_finished_spans()
    assert format(root.context.trace_id, "032x") == r.headers["x-trace-id"]
    assert root.status.status_code != StatusCode.ERROR


def test_a_refused_start_ends_the_root_span(exporter, tmp_path, rewrites):
    class OneRun(AnonymousPolicy):
        def run_owner(self, request):
            return "me"

        def max_runs_per_owner(self, request):
            return 0

    client = serve(tmp_path, StubPipeline(), policy=OneRun())
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    client.app.state.tracer = provider.get_tracer("t")
    assert say(client).status_code == 429
    assert [s.name for s in exporter.get_finished_spans()] == ["chat"]


def test_a_usage_without_a_model_has_no_model_attribute(exporter):
    step = [s for s in run(exporter, [finished("answer", {"input_tokens": 1, "output_tokens": 2})]) if s.name == "answer"][0]
    assert "gen_ai.request.model" not in step.attributes


def test_spans_end_even_when_the_client_disconnects(exporter):
    turn = turn_of(exporter)
    turn.finish(False)  # the turn was cancelled before any step ended
    turn.finish(False)  # a second finish does nothing
    assert [s.name for s in exporter.get_finished_spans()] == ["chat"]


def test_a_rate_limited_turn_ends_the_root_span(exporter, tmp_path, rewrites):
    client = serve(tmp_path, StubPipeline())
    from pandion_api.limits import TurnLimiter

    client.app.state.limiter = TurnLimiter(0, 2)
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    client.app.state.tracer = provider.get_tracer("t")
    assert say(client).status_code == 429
    assert [s.name for s in exporter.get_finished_spans()] == ["chat"]
