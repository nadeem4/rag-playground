"""Evaluation of a pipeline with an `access:` block runs as admin (every role)."""

import pytest

import pandion
from pandion import Pipeline
from pandion.evaluation import reask_missed, stale_check
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
  search: {use: dense, top_k: 5}
access:
  default: [staff]
"""

FOUND = {
    "id": "capital",
    "question": "What is the capital of France?",
    "gold_answer": "The capital of France is Paris.",
}


@pytest.fixture
def p(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "sample.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    file = tmp_path / "pipeline.yaml"
    file.write_text(CONFIG, encoding="utf-8")
    pipeline = Pipeline.from_file(file)
    pipeline.index.sync(folder)
    return pipeline


def test_evaluate_with_an_access_block_runs_as_admin(p):
    report = pandion.evaluate(p, [FOUND])
    assert report.questions[0].error is None
    assert report.questions[0].found is True


def test_stale_check_and_reask_missed_with_an_access_block_run_as_admin(p):
    assert stale_check(p, [FOUND]).ok
    report = pandion.evaluate(p, [FOUND])
    again, asked = reask_missed(p, report, {}, [FOUND])
    assert asked == [] and again.questions[0].error is None
