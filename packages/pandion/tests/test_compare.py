"""pandion.compare: one stage, several settings, every upstream step shared."""

import json

import pytest

import pandion
from pandion import Pipeline
from pandion.chunk import RecursiveCharacter
from pandion.config import ConfigError
from pdfs import SAMPLE_PAGES, build_pdf

FOUND = {"id": "capital", "question": "What is the capital of France?",
         "gold_answer": "The capital of France is Paris."}
V70 = {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10}
V30 = {"use": "recursive_character", "chunk_size": 30, "chunk_overlap": 0}


def pipeline(tmp_path):
    return Pipeline(
        path=tmp_path / "index",
        parse="pdfium",
        chunk=V70,
        embed="fake-deterministic",
        store="lancedb",
        search={"use": "hybrid_rrf", "top_k": 5},
    )


@pytest.fixture
def docs(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "sample.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return folder


def test_compare_is_public():
    for name in ("compare", "Comparison"):
        assert name in pandion.__all__
    assert pandion.evaluation.compare is pandion.compare


def test_two_chunk_sizes_evaluated(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V70, V30], docs, [FOUND])
    assert [r.variant for r in results] == [V70, V30]
    assert [r.report.found for r in results] == [1, 0]
    assert results[1].report.questions[0].lost_at == "chunk"
    assert results[1].pipeline.config.index.chunk == ("recursive_character", {"chunk_size": 30, "chunk_overlap": 0})


def test_the_steps_above_the_varied_one_are_shared(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V70, V30], docs)
    parses = [r.index.documents["sample.pdf"].stages["parse"] for r in results]
    assert parses[0].artifact_id == parses[1].artifact_id
    assert parses[1].status == "cached"


def test_without_questions_each_result_holds_the_step_output(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V70, RecursiveCharacter(chunk_size=30, chunk_overlap=0)], docs)
    assert [r.report for r in results] == [None, None]
    assert [len(r.outputs["sample.pdf"].output.chunks) for r in results] == [5, 10]


def test_a_retrieval_stage_reuses_one_index(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "search", ["bm25", {"use": "hybrid_rrf", "top_k": 5}], docs, [FOUND])
    assert results[0].report.found == 1
    assert results[1].index.index.status == "cached"
    assert results[0].outputs == {}


def test_a_bad_variant_is_refused_before_any_variant_runs(tmp_path, docs):
    p = pipeline(tmp_path)
    with pytest.raises(ConfigError, match=r"variant 2: index\.chunk \(recursive_character\) has no setting 'chunk_sise'"):
        pandion.compare(p, "chunk", [V70, {"use": "recursive_character", "chunk_sise": 5}], docs)
    assert p.index.documents is None


def test_only_a_named_stage_can_be_varied(tmp_path, docs):
    with pytest.raises(ValueError, match="'answer' is not one of them"):
        pandion.compare(pipeline(tmp_path), "answer", [{"use": "search"}], docs, [FOUND])


def test_comparing_a_retrieval_stage_needs_questions(tmp_path, docs):
    with pytest.raises(ValueError, match="Comparing search needs questions"):
        pandion.compare(pipeline(tmp_path), "search", ["bm25"], docs)


def test_no_variants_is_refused(tmp_path, docs):
    with pytest.raises(ValueError, match="at least one variant"):
        pandion.compare(pipeline(tmp_path), "chunk", [], docs)


def test_a_comparison_as_a_dict_is_plain_json(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V70], docs, [FOUND])
    data = json.loads(json.dumps(results[0].to_dict()))
    assert data["stage"] == "chunk" and data["variant"] == V70 and data["ok"] is True
    assert data["outputs"]["sample.pdf"]["artifact_id"]
    assert data["report"]["found"] == 1


def test_the_results_print_one_plain_line_per_variant_and_the_best(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V30, V70], docs, [FOUND])
    assert str(results).splitlines() == [
        "chunk recursive_character chunk_size=30 chunk_overlap=0: found 0 of 1",
        "chunk recursive_character chunk_size=70 chunk_overlap=10: found 1 of 1",
        "Best: recursive_character chunk_size=70 chunk_overlap=10, found 1 of 1.",
    ]


def test_a_single_variant_that_found_the_answer_is_named_best(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "search", ["bm25"], docs, [FOUND])
    assert str(results).splitlines() == [
        "search bm25: found 1 of 1",
        "Best: bm25, found 1 of 1.",
    ]


def test_without_questions_the_lines_say_nothing_was_asked(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V70], docs)
    assert str(results).splitlines() == [
        "chunk recursive_character chunk_size=70 chunk_overlap=10: indexed, no questions asked",
    ]


def test_a_tie_for_best_names_every_tied_variant(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V70, V70], docs, [FOUND])
    assert str(results).splitlines()[-1] == (
        "Best: recursive_character chunk_size=70 chunk_overlap=10, found 1 of 1, "
        "tied with recursive_character chunk_size=70 chunk_overlap=10."
    )


@pytest.fixture
def broken_chunker():
    """A chunker that raises when it runs, removed after the test."""
    from pydantic import BaseModel

    from pandion.extend import ArtifactType, PortSpec, Stage, Transform, register
    from pandion.registry import registry

    class NoSettings(BaseModel):
        pass

    @register
    class Broken(Transform[NoSettings]):
        name = "test_broken_chunker"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = NoSettings
        summary = "Always fails."

        def apply(self, inputs, config, ctx):
            raise RuntimeError("this chunker always fails")

    yield "test_broken_chunker"
    registry._by_stage[Stage.CHUNK].pop("test_broken_chunker", None)


def test_a_variant_whose_index_run_fails_is_reported_and_the_rest_still_run(tmp_path, docs, broken_chunker):
    results = pandion.compare(pipeline(tmp_path), "chunk", [broken_chunker, V70], docs, [FOUND])
    assert results[0].index.ok is False
    assert results[0].report is None
    assert results[0].to_dict()["ok"] is False
    assert results[1].report.found == 1
    assert str(results).splitlines() == [
        "chunk test_broken_chunker: the index run failed",
        "chunk recursive_character chunk_size=70 chunk_overlap=10: found 1 of 1",
        "Best: recursive_character chunk_size=70 chunk_overlap=10, found 1 of 1.",
    ]


def test_when_no_variant_found_an_answer_none_is_named_best(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V30], docs, [FOUND])
    assert str(results).splitlines() == [
        "chunk recursive_character chunk_size=30 chunk_overlap=0: found 0 of 1",
        "No variant found an answer.",
    ]


def _made(variant, *verdicts):
    """A comparison with a made-up report: each verdict is a rank, None for a
    miss, or "error" for a question whose retrieval failed."""
    from types import SimpleNamespace

    questions = [
        pandion.QuestionResult(
            id=f"q{n}", question="?", golds=["."], tags=[], found=isinstance(v, int), rank=v if isinstance(v, int) else None,
            lost_at=None, trace=None, score={}, error="failed" if v == "error" else None,
        )
        for n, v in enumerate(verdicts)
    ]
    return pandion.Comparison(stage="search", variant=variant, pipeline=None,
                              index=SimpleNamespace(ok=True), report=pandion.EvaluationReport(top_k=5, questions=questions))


def test_the_best_is_the_higher_hit_rate_then_the_higher_mean_reciprocal_rank():
    same_count = pandion.Comparisons([_made("bm25", 3, None), _made("dense", 1, None)])
    assert str(same_count).splitlines()[-1] == "Best: dense, found 1 of 2."
    fewer_scored = pandion.Comparisons([_made("bm25", 1, None), _made("dense", 2, "error")])
    assert str(fewer_scored).splitlines() == [
        "search bm25: found 1 of 2",
        "search dense: found 1 of 1",
        "Best: dense, found 1 of 1.",
    ]


def test_comparisons_slice_to_a_plain_list():
    assert "Comparisons" in pandion.__all__
    results = pandion.Comparisons([_made("bm25", 1)])
    assert type(results[:1]) is list


def test_a_bare_name_for_clean_or_rerank_is_taken_as_a_list_of_one(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "clean", ["dedupe_blocks"], docs)
    assert results[0].pipeline.config.index.clean == [("dedupe_blocks", {})]
    assert results[0].index.ok
    results = pandion.compare(pipeline(tmp_path), "rerank", ["mmr"], docs, [FOUND])
    assert results[0].pipeline.config.retrieve.rerank == [("mmr", {})]
    assert results[0].report.found == 1


def test_best_is_every_tied_comparison_by_hit_rate_then_mean_reciprocal_rank():
    first, second, third = _made("bm25", 1, None), _made("dense", 1, None), _made("hybrid", 2, None)
    assert pandion.Comparisons([first, second, third]).best == [first, second]
    assert pandion.Comparisons([_made("bm25", None)]).best == []          # nothing found
    assert pandion.Comparisons([_made("bm25", "error")]).best == []       # nothing scored
    unasked = pandion.Comparison(stage="chunk", variant=V70, pipeline=None, index=None, report=None)
    assert pandion.Comparisons([unasked]).best == []


def test_comparisons_as_a_dict_is_plain_json_with_the_best_by_index(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "chunk", [V30, V70, V70], docs, [FOUND])
    data = json.loads(json.dumps(results.to_dict()))
    assert [c["variant"] for c in data["comparisons"]] == [V30, V70, V70]
    assert data["comparisons"][1] == json.loads(json.dumps(results[1].to_dict()))
    assert data["best"] == [1, 2]


@pytest.fixture
def drop_all_reranker():
    """A reranker that keeps no pieces, removed after the test."""
    from pydantic import BaseModel

    from pandion.extend import ArtifactType, PortSpec, Stage, Transform, register
    from pandion.payloads import RetrievalResult
    from pandion.registry import registry

    class NoSettings(BaseModel):
        pass

    @register
    class DropAll(Transform[NoSettings]):
        name = "test_drop_all"
        stage = Stage.RERANK
        inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = NoSettings
        summary = "Keeps no pieces."

        def apply(self, inputs, config, ctx):
            result = RetrievalResult.model_validate(inputs["result"])
            return result.model_copy(update={"hits": []}).model_dump(mode="json")

    yield "test_drop_all"
    registry._by_stage[Stage.RERANK].pop("test_drop_all", None)


def test_evaluate_traces_a_miss_through_the_last_reranker(tmp_path, docs, drop_all_reranker):
    p = Pipeline(
        path=tmp_path / "index", parse="pdfium", chunk=V70, embed="fake-deterministic", store="lancedb",
        search={"use": "hybrid_rrf", "top_k": 5}, rerank=["mmr", drop_all_reranker],
    )
    q = pandion.evaluate(p, [FOUND], documents=docs).questions[0]
    assert (q.found, q.lost_at) == (False, "rerank")
    assert q.trace["finding"] == "Lost at Rerank. test_drop_all dropped piece 1."
    assert q.result_id == q.retrieval.stages["rerank"][-1].artifact_id


@pytest.fixture
def broken_search():
    """A search that raises when it runs, removed after the test."""
    from pydantic import BaseModel

    from pandion.extend import ArtifactType, PortSpec, Stage, Transform, register
    from pandion.registry import registry

    class NoSettings(BaseModel):
        pass

    @register
    class Broken(Transform[NoSettings]):
        name = "test_broken_search"
        stage = Stage.RETRIEVE
        inputs = {
            "index": PortSpec(ArtifactType.INDEX),
            "query": PortSpec(ArtifactType.QUERY, ambient=True),
        }
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = NoSettings
        summary = "Always fails."

        def apply(self, inputs, config, ctx):
            raise RuntimeError("this search always fails")

    yield "test_broken_search"
    registry._by_stage[Stage.RETRIEVE].pop("test_broken_search", None)


def test_a_question_whose_retrieval_fails_carries_the_error_and_is_left_out_of_the_rates(
    tmp_path, docs, broken_search
):
    p = Pipeline(path=tmp_path / "index", parse="pdfium", chunk=V70, embed="fake-deterministic",
                 store="lancedb", search=broken_search)
    report = pandion.evaluate(p, [FOUND], documents=docs)
    q = report.questions[0]
    assert "test_broken_search" in q.error and "this search always fails" in q.error
    assert (q.found, q.lost_at, q.trace, q.result_id) == (False, None, None, None)
    t = report.totals()
    assert (t["total"], t["scored"], t["hit_rate"], t["mrr"]) == (1, 0, None, None)
