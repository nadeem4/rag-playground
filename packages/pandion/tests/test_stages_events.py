"""Single steps emit the same events the executor does."""

from __future__ import annotations

from pathlib import Path

import pytest

import pandion
from test_stages import notice_doc


def _calls(sample_pdf: Path):
    """Each step as (stage, a callable taking on_event and trace_id)."""
    doc = notice_doc()
    return [
        ("parse", lambda **kw: pandion.parse(sample_pdf, use="pdfium", **kw)),
        ("clean", lambda **kw: pandion.clean(doc, steps=[{"use": "dedupe_blocks"}], **kw)),
        ("chunk", lambda **kw: pandion.chunk(doc, use="recursive_character", **kw)),
        ("query", lambda **kw: pandion.rewrite("What is it?", use="text", **kw)),
    ]


@pytest.mark.parametrize("stage", ["parse", "clean", "chunk", "query"])
def test_a_step_emits_started_then_finished_with_its_stage(sample_pdf, stage):
    call = dict(_calls(sample_pdf))[stage]
    events: list[dict] = []
    call(on_event=events.append)

    assert [e["event"] for e in events] == ["node_started", "node_finished"]
    started, finished = events
    assert started["node_id"] == stage and started["stage"] == stage
    assert started["transform"]
    assert finished["node_id"] == stage and finished["stage"] == stage
    assert finished["cache_hit"] is False
    assert finished["duration_ms"] >= 0 and "usage" in finished
    assert all("trace_id" not in e for e in events)


def test_a_failed_step_emits_node_failed_then_raises(tmp_path):
    events: list[dict] = []
    with pytest.raises(FileNotFoundError):
        pandion.parse(tmp_path / "missing.pdf", use="pdfium", on_event=events.append)

    assert [e["event"] for e in events] == ["node_started", "node_failed"]
    assert events[1]["stage"] == "parse"
    assert isinstance(events[1]["error"], str) and events[1]["error"]


def test_stage_events_carry_the_trace_id(sample_pdf):
    for _, call in _calls(sample_pdf):
        events: list[dict] = []
        call(on_event=events.append, trace_id="t-9")
        assert events and all(e["trace_id"] == "t-9" for e in events)


def test_no_on_event_is_as_before(sample_pdf):
    assert pandion.parse(sample_pdf, use="pdfium").stage == "parse"
