"""A newly missed question is asked once more when a step can differ between runs (spec 8.4)."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

import pandion
from pandion import Pipeline
from pandion.evaluation import reask_missed
from pdfs import SAMPLE_PAGES, build_pdf

FOUND = {
    "id": "capital", "question": "What is the capital of France?",
    "gold_answer": "The capital of France is Paris.", "tags": ["fact"],
}


class NoSettings(BaseModel):
    pass


def flaky_reranker(label: str, fail_first: int, steady: bool):
    """A reranker that keeps no pieces for its first `fail_first` calls, then passes them through."""
    from pandion.extend import ArtifactType, PortSpec, Stage, Transform, register
    from pandion.payloads import RetrievalResult

    calls = {"n": 0}

    @register
    class Flaky(Transform[NoSettings]):
        name = label
        deterministic = steady
        cacheable = False  # as the LLM steps are: a re-ask must run it again
        stage = Stage.RERANK
        inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = NoSettings
        summary = "Drops every piece at first."

        def apply(self, inputs, config, ctx):
            calls["n"] += 1
            result = RetrievalResult.model_validate(inputs["result"])
            if calls["n"] <= fail_first:
                result = result.model_copy(update={"hits": []})
            return result.model_dump(mode="json")

    return calls


@pytest.fixture
def docs(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "sample.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return folder


@pytest.fixture
def setup(tmp_path, docs):
    from pandion.extend import Stage
    from pandion.registry import registry

    def make(name: str, fail_first: int, deterministic: bool = False):
        calls = flaky_reranker(name, fail_first, deterministic)
        p = Pipeline(
            path=tmp_path / "index", parse="pdfium",
            chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
            embed="fake-deterministic", store="lancedb",
            search={"use": "hybrid_rrf", "top_k": 5}, rerank=[name],
        )
        p.index.run(docs)
        return p, calls

    yield make
    for name in ("test_flaky_rerank", "test_steady_rerank"):
        registry._by_stage[Stage.RERANK].pop(name, None)


def baseline_found():
    """A baseline in which the question was found."""
    return {"top_k": 5, "questions": [{"id": "capital", "question": FOUND["question"], "golds": [FOUND["gold_answer"]], "found": True, "tags": ["fact"]}]}


def test_a_question_that_passes_on_the_re_ask_is_no_longer_newly_missed(setup, docs):
    p, calls = setup("test_flaky_rerank", fail_first=1)
    report = pandion.evaluate(p, [FOUND], documents=docs)
    assert not report.questions[0].found and report.nondeterministic == ["test_flaky_rerank"]
    again, reasked = reask_missed(p, report, baseline_found(), [FOUND], 5, documents=docs)
    assert reasked == ["capital"]
    assert again.questions[0].found
    assert again.against(baseline_found()).newly_missed == []
    assert calls["n"] == 2


def test_a_question_that_keeps_failing_stays_newly_missed(setup, docs):
    p, calls = setup("test_flaky_rerank", fail_first=99)
    report = pandion.evaluate(p, [FOUND], documents=docs)
    again, reasked = reask_missed(p, report, baseline_found(), [FOUND], 5, documents=docs)
    assert reasked == ["capital"]
    assert again.against(baseline_found()).newly_missed == ["capital"]
    assert calls["n"] == 2  # once more, not until it passes


def test_nothing_is_re_asked_when_every_step_is_deterministic(setup, docs):
    p, calls = setup("test_steady_rerank", fail_first=99, deterministic=True)
    report = pandion.evaluate(p, [FOUND], documents=docs)
    again, reasked = reask_missed(p, report, baseline_found(), [FOUND], 5, documents=docs)
    assert reasked == [] and again is report
    assert calls["n"] == 1


def test_only_the_newly_missed_questions_are_re_asked(setup, docs):
    p, calls = setup("test_flaky_rerank", fail_first=0)
    report = pandion.evaluate(p, [FOUND], documents=docs)
    again, reasked = reask_missed(p, report, baseline_found(), [FOUND], 5, documents=docs)
    assert reasked == [] and calls["n"] == 1
