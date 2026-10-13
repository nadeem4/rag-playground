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


def test_without_questions_the_lines_say_nothing_was_asked(tmp_path, docs):
    results = pandion.compare(pipeline(tmp_path), "search", ["bm25"], docs, [FOUND])
    assert str(results).splitlines() == [
        "search bm25: found 1 of 1",
        "Best: bm25, found 1 of 1.",
    ]
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
