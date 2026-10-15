"""The cost of part of a run, and of several runs together.

`cost(since=...)` counts the steps at a stage and after it, `cost(before=...)`
the steps before it, so a comparison can show each variant's own cost (the
varied step and after) and the shared steps once. `pandion.total_cost` adds
several reports up with each step counted once across all of them.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel

import pandion
from pandion import Pipeline
from pandion.artifacts import ArtifactType
from pandion.cost import STAGE_ORDER
from pandion.evaluation import Comparison, Comparisons
from pandion.extend import PortSpec, Stage, Transform, register, set_usage
from pandion.pipeline import Answer, DocumentReport, IndexReport, Retrieval
from pandion.results import StageResult
from pdfs import SAMPLE_PAGES, build_pdf

TABLE = {"model-a": (2.0, 10.0)}
FOUND = {"id": "capital", "question": "What is the capital of France?",
         "gold_answer": "The capital of France is Paris."}


def step(stage, status="executed", ms=0.0, usage=None, artifact=None) -> StageResult:
    return StageResult(
        stage=stage, transform="t", output=None, status=status,
        duration_ms=ms, usage=usage, artifact_id=artifact,
    )


def use(i, o):
    return {"input_tokens": i, "output_tokens": o, "model": "model-a"}


def answer() -> Answer:
    """A run with a time, tokens and dollars at every stage from parse to answer."""
    retrieval = Retrieval(
        stages={
            "rewrite": step("rewrite", ms=100, usage=use(1_000, 10)),
            "search": step("search", ms=200),
            "rerank": [step("rerank", ms=400, usage=use(2_000, 20))],
        },
        index=step("index", ms=800),
        upstream=[step("source", ms=5), step("parse", ms=1000), step("clean", ms=50), step("chunk", ms=25)],
    )
    return Answer(retrieval=retrieval, answer=step("answer", ms=1600, usage=use(4_000, 40)))


# -- since and before ----------------------------------------------------------------------


def test_since_counts_the_stage_and_after_and_before_counts_the_rest():
    a = answer()
    after = a.cost(prices=TABLE, since="rerank")
    assert after["seconds"] == pytest.approx(2.0)
    assert after["input_tokens"] == 6_000 and after["output_tokens"] == 60
    # 6000 * 2 + 60 * 10, per million
    assert after["dollars"] == pytest.approx(0.0126)
    assert after["steps_run"] == 2

    earlier = a.cost(prices=TABLE, before="rerank")
    assert earlier["seconds"] == pytest.approx(2.18)
    assert earlier["input_tokens"] == 1_000 and earlier["output_tokens"] == 10
    assert earlier["dollars"] == pytest.approx(0.0021)
    assert earlier["steps_run"] == 7

    whole = a.cost(prices=TABLE)
    assert after["seconds"] + earlier["seconds"] == pytest.approx(whole["seconds"])
    assert after["input_tokens"] + earlier["input_tokens"] == whole["input_tokens"]
    assert after["dollars"] + earlier["dollars"] == pytest.approx(whole["dollars"])
    assert after["steps_run"] + earlier["steps_run"] == whole["steps_run"]


def test_clean_and_the_index_fall_in_pipeline_order():
    a = answer()
    assert a.cost(since="clean")["steps_run"] == 7
    # embed and store are both the index step.
    assert a.cost(since="embed") == a.cost(since="store") == a.cost(since="index")
    assert a.cost(since="embed")["steps_run"] == 5


def test_the_stage_order_is_pipeline_order():
    order = sorted(STAGE_ORDER, key=STAGE_ORDER.get)
    assert order[:4] == ["source", "parse", "clean", "chunk"]
    assert order[-4:] == ["rewrite", "search", "rerank", "answer"]
    assert STAGE_ORDER["embed"] == STAGE_ORDER["store"] == STAGE_ORDER["index"]


def test_an_unknown_stage_raises():
    with pytest.raises(ValueError, match="rerankk"):
        answer().cost(since="rerankk")
    with pytest.raises(ValueError, match="nope"):
        answer().cost(before="nope")
    with pytest.raises(ValueError, match="nope"):
        pandion.total_cost([answer()], since="nope")


def test_every_report_takes_since_and_before():
    index = IndexReport(
        documents={"a": DocumentReport(stages={"parse": step("parse", ms=700), "chunk": step("chunk", ms=300)})},
        index=step("index", ms=100),
    )
    assert index.cost(since="chunk")["seconds"] == pytest.approx(0.4)
    assert index.cost(before="chunk")["seconds"] == pytest.approx(0.7)
    assert answer().retrieval.cost(since="search")["seconds"] == pytest.approx(0.6)
    comparison = Comparison(stage="chunk", variant={}, pipeline=None, index=index, report=None)
    assert comparison.cost(since="index")["seconds"] == pytest.approx(0.1)


# -- total_cost ----------------------------------------------------------------------------


def test_total_cost_is_public():
    assert "total_cost" in pandion.__all__


def test_total_cost_skips_a_cached_read_of_a_step_another_report_ran():
    ran = IndexReport(documents={"a": DocumentReport(stages={"parse": step("parse", ms=500, artifact="p" * 64)})}, index=None)
    read = IndexReport(documents={"a": DocumentReport(stages={"parse": step("parse", "cached", artifact="p" * 64)})}, index=None)
    total = pandion.total_cost([read, ran])
    assert total["steps_run"] == 1 and total["steps_cached"] == 0
    assert total["seconds"] == pytest.approx(0.5)


def test_total_cost_counts_a_cached_step_several_reports_read_once():
    reports = [
        IndexReport(documents={"a": DocumentReport(stages={"parse": step("parse", "cached", artifact="p" * 64)})}, index=None)
        for _ in range(3)
    ]
    total = pandion.total_cost(reports)
    assert total["steps_run"] == 0 and total["steps_cached"] == 1


def test_total_cost_of_no_reports_is_zero_steps():
    total = pandion.total_cost([])
    assert total["steps_run"] == 0 and total["seconds"] == 0


def test_comparisons_cost_is_their_total_cost():
    index = IndexReport(documents={"a": DocumentReport(stages={"parse": step("parse", ms=500)})}, index=None)
    both = Comparisons([Comparison(stage="chunk", variant={}, pipeline=None, index=index, report=None)] * 2)
    assert both.cost() == pandion.total_cost(both)
    assert both.cost(before="chunk") == pandion.total_cost(both, before="chunk")


# -- a real comparison of two rerankers on a cold cache --------------------------------


class PauseCfg(BaseModel):
    tag: str = ""


@pytest.fixture
def tagged_rerank():
    """A rerank step that keeps the order and records usage; its tag makes each variant its own step."""

    @register
    class TaggedRerank(Transform[PauseCfg]):
        name = "test_tagged_rerank"
        stage = Stage.RERANK
        inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = PauseCfg
        summary = "Keeps the order and records made-up usage."

        def apply(self, inputs, config, ctx):
            set_usage(ctx, {"input_tokens": 9, "output_tokens": 4}, "model-a")
            return inputs["result"]

    yield
    from pandion.registry import registry

    registry._by_stage[Stage.RERANK].pop("test_tagged_rerank", None)


def test_compare_names_the_varied_stage_and_splits_its_cost(tmp_path, tagged_rerank):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "sample.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    p = Pipeline(
        path=tmp_path / "index", parse="pdfium",
        chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        embed="fake-deterministic", store="lancedb", search={"use": "bm25", "top_k": 5},
    )
    variants = [{"use": "test_tagged_rerank", "tag": "a"}, {"use": "test_tagged_rerank", "tag": "b"}]
    results = pandion.compare(p, "rerank", variants, docs, [FOUND])
    assert results.varied_from == "rerank"

    first, second = results
    for c in results:
        varied = c.cost(prices=TABLE, since="rerank")
        reranks = [s for s in c._steps() if s.stage == "rerank" and s.status == "executed"]
        assert varied["steps_run"] == len(reranks) == 1
        assert varied["input_tokens"] == 9
        assert varied["seconds"] == pytest.approx(sum(s.duration_ms for s in reranks) / 1000)

    # The first variant ran the shared steps; none of them is in its varied cost.
    shared_first = first.cost(before="rerank")
    assert shared_first["steps_run"] > 0
    assert first.cost(since="rerank")["seconds"] < first.cost()["seconds"]
    assert second.cost(before="rerank")["steps_run"] == 0

    shared = pandion.total_cost(results, before="rerank")
    assert shared["steps_run"] == shared_first["steps_run"]
    assert shared["seconds"] == pytest.approx(shared_first["seconds"])
    assert shared["steps_cached"] == 0
    assert all(s.stage in STAGE_ORDER for c in results for s in c._steps())


def test_comparisons_built_by_hand_have_no_varied_stage():
    assert Comparisons().varied_from is None
