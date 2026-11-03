"""The serve metrics: what they count, and the labels they may carry."""

import subprocess
import sys
from types import SimpleNamespace

import pytest

pytest.importorskip("prometheus_client")
from pandion_api.metrics import Metrics

USAGE = {"model": "claude-x", "input_tokens": 7, "output_tokens": 9}


def value(m, name, **labels):
    return m.registry.get_sample_value(name, labels)


def finished(stage, usage=None):
    return {"event": "node_finished", "stage": stage, "duration_ms": 250.0, "usage": usage}


def answer(dollars=0.002):
    return SimpleNamespace(cost=lambda: {"dollars": dollars})


def test_a_turn_updates_requests_steps_tokens_and_cost():
    m = Metrics()
    m.request("/chat", 200)
    m.on_event(finished("answer", USAGE))
    m.turn_done(answer(0.002))
    assert value(m, "requests_total", route="/chat", status="200") == 1
    assert value(m, "step_seconds_count", step="answer") == 1
    assert value(m, "step_seconds_sum", step="answer") == 0.25
    assert value(m, "tokens_total", step="answer", kind="input") == 7
    assert value(m, "tokens_total", step="answer", kind="output") == 9
    assert value(m, "cost_estimated_usd_total") == 0.002


def test_a_failed_step_counts_an_error_for_its_stage():
    m = Metrics()
    m.on_event({"event": "node_failed", "stage": "rerank"})
    assert value(m, "errors_total", step="rerank") == 1


def test_route_label_is_the_template_not_the_path():
    m = Metrics()
    m.request("/conversations/{conversation_id}", 200)
    m.request("/conversations/{conversation_id}", 200)
    assert value(m, "requests_total", route="/conversations/{conversation_id}", status="200") == 2


def test_no_label_carries_a_user_conversation_or_chunk_id():
    m = Metrics()
    m.request("/chat", 200)
    m.on_event(finished("answer", USAGE))
    m.on_event({"event": "node_failed", "stage": "rerank", "conversation_id": "conv-secret", "chunk_id": "c-secret"})
    m.turn_done(answer(), ["low_grounding"])
    m.feedback("up", "")
    samples = [s for metric in m.registry.collect() for s in metric.samples]
    seen = {v for s in samples for k, v in s.labels.items() if k != "le"}
    assert seen == {"/chat", "200", "answer", "input", "output", "rerank", "low_grounding", "up", ""}


def test_flagged_metric_uses_the_flag_names():
    m = Metrics()
    m.turn_done(answer(), ["low_grounding", "not_in_documents"])
    m.turn_done(answer(), [])
    assert value(m, "turns_flagged_total", category="low_grounding") == 1
    assert value(m, "turns_flagged_total", category="not_in_documents") == 1
    assert value(m, "turns_flagged_total", category="declined") is None
    assert value(m, "turns_flagged_total", category="weak") is None


def test_a_turn_with_no_priced_model_adds_no_cost():
    m = Metrics()
    m.turn_done(answer(dollars=None))
    assert value(m, "cost_estimated_usd_total") == 0


def test_two_metrics_objects_do_not_share_series():
    a, b = Metrics(), Metrics()
    a.request("/chat", 200)
    assert value(b, "requests_total", route="/chat", status="200") is None


def test_prometheus_client_is_imported_only_when_metrics_are_on():
    code = "import sys\nimport pandion_api.serve\nassert 'prometheus_client' not in sys.modules, 'imported'\n"
    subprocess.run([sys.executable, "-c", code], check=True)
