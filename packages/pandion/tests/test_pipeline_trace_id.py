"""The caller's trace id reaches every event of a pipeline call."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from pandion import Pipeline
from pdfs import SAMPLE_PAGES, build_pdf

CONFIG = """\
path: ./index
models:
  device: cpu
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character, chunk_size: 70, chunk_overlap: 10}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
retrieve:
  search: {use: bm25, top_k: 4}
answer: {use: search, top_k: 2}
"""
QUESTION = "What is the capital of France?"


@pytest.fixture
def pdf(tmp_path: Path) -> Path:
    f = tmp_path / "report.pdf"
    f.write_bytes(build_pdf(SAMPLE_PAGES))
    return f


@pytest.fixture
def p(tmp_path: Path, pdf: Path) -> Pipeline:
    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG, encoding="utf-8")
    pipeline = Pipeline.from_yaml(config)
    assert pipeline.index.run(pdf).ok
    return pipeline


def assert_all_traced(events, trace_id):
    assert events
    assert all(e["trace_id"] == trace_id for e in events)


def test_retrieve_events_carry_the_trace_id(p):
    events: list[dict] = []
    p.retrieve(QUESTION, on_event=events.append, trace_id="r-1")
    assert_all_traced(events, "r-1")


def test_ask_events_carry_the_trace_id(p):
    events: list[dict] = []
    p.ask(QUESTION, on_event=events.append, trace_id="a-1")
    assert_all_traced(events, "a-1")


def test_index_run_events_carry_the_trace_id(tmp_path, pdf):
    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG, encoding="utf-8")
    events: list[dict] = []
    Pipeline.from_yaml(config).index.run(pdf, on_event=events.append, trace_id="i-1")
    assert_all_traced(events, "i-1")


def test_events_from_a_worker_thread_keep_the_trace_id(p):
    events: list[dict] = []
    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(p.retrieve, QUESTION, on_event=events.append, trace_id="w-1").result()
    assert_all_traced(events, "w-1")
