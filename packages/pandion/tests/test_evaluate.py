"""pandion.evaluate: each question found or missed, where a miss was lost, and totals.

One small PDF, pdfium, the fake embedder and hybrid search: nothing reaches the
network. The chunk size decides where an answer is lost: at 70 characters the
capital sentence is whole in one piece; at 30 it is cut across two.
"""

import json

import pytest

import pandion
from pandion import Pipeline
from pandion.evaluation import QuestionSetError
from pdfs import SAMPLE_PAGES, build_pdf

FOUND = {
    "id": "capital",
    "question": "What is the capital of France?",
    "gold_answer": "The capital of France is Paris.",
    "tags": ["fact"],
}
NOT_IN_DOC = {
    "id": "spain",
    "question": "What is the capital of Spain?",
    "gold_answer": "Madrid is the capital of Spain.",
    "tags": ["fact", "planted"],
}
OTHER_DOC = [["Bees dance to show the hive where the flowers are."], ["Honey keeps for years."]]


def pipeline(tmp_path, chunk_size=70, overlap=10):
    return Pipeline(
        path=tmp_path / "index",
        parse="pdfium",
        chunk={"use": "recursive_character", "chunk_size": chunk_size, "chunk_overlap": overlap},
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


def test_evaluate_is_public():
    for name in ("evaluate", "EvaluationReport", "QuestionResult"):
        assert name in pandion.__all__
    assert pandion.evaluation.evaluate is pandion.evaluate


def test_a_found_question_has_its_rank_and_no_trace(tmp_path, docs):
    p = pipeline(tmp_path)
    p.index.run(docs)
    report = pandion.evaluate(p, [FOUND])
    q = report.questions[0]
    assert (q.id, q.found, q.rank, q.lost_at, q.trace, q.error) == ("capital", True, 1, None, None, None)
    assert q.score["match"] == "exact" and q.score["considered"] == 5
    assert (report.found, report.total, report.top_k) == (1, 1, 5)
    assert q.retrieval.ok


def test_a_miss_says_where_it_was_lost_with_the_trace(tmp_path, docs):
    p = pipeline(tmp_path)
    p.index.run(docs)
    q = pandion.evaluate(p, [NOT_IN_DOC]).questions[0]
    assert (q.found, q.rank, q.lost_at) == (False, None, "parse")
    assert q.trace["finding"] == "Lost at Parse. The answer is not in the text pdfium produced."
    assert [s["stage"] for s in q.trace["steps"]] == ["parse", "chunk", "search", "top_k"]
    assert q.trace["document"] == "sample.pdf"


def test_an_answer_cut_across_pieces_is_lost_at_chunk(tmp_path, docs):
    p = pipeline(tmp_path, chunk_size=30, overlap=0)
    p.index.run(docs)
    q = pandion.evaluate(p, [FOUND]).questions[0]
    assert (q.found, q.lost_at) == (False, "chunk")
    assert q.trace["finding"] == "Lost at Chunk. No piece holds the whole answer."


def test_a_miss_is_traced_in_the_document_that_holds_the_answer(tmp_path, docs):
    (docs / "aaa-bees.pdf").write_bytes(build_pdf(OTHER_DOC))   # first by name, but not the one
    p = pipeline(tmp_path, chunk_size=30, overlap=0)
    p.index.run(docs)
    q = pandion.evaluate(p, [FOUND]).questions[0]
    assert q.trace["document"] == "sample.pdf"
    assert q.lost_at == "chunk"


def test_documents_indexes_them_first(tmp_path, docs):
    report = pandion.evaluate(pipeline(tmp_path), [FOUND], documents=docs)
    assert report.found == 1


def test_without_an_index_it_says_to_build_one(tmp_path):
    with pytest.raises(ValueError, match="There is no index to search yet"):
        pandion.evaluate(pipeline(tmp_path), [FOUND])


def test_a_question_set_file_and_the_totals(tmp_path, docs):
    f = tmp_path / "questions.json"
    f.write_text(json.dumps([FOUND, NOT_IN_DOC]), encoding="utf-8")
    report = pandion.evaluate(pipeline(tmp_path), f, documents=docs)
    assert [q.found for q in report.questions] == [True, False]
    assert report.totals() == {
        "total": 2, "scored": 2, "found": 1, "hit_rate": 0.5, "mrr": 0.5,
        "recall": None, "mean_rank": 1.0, "median_rank": 1.0,
    }
    by_tag = report.by_tag()
    assert sorted(by_tag) == ["fact", "planted"]
    assert (by_tag["fact"]["found"], by_tag["fact"]["total"]) == (1, 2)
    assert by_tag["planted"]["hit_rate"] == 0.0


def test_recall_counts_gold_passages_when_a_question_has_several(tmp_path, docs):
    two = {**FOUND, "gold_answers": ["Madrid is the capital of Spain."]}
    report = pandion.evaluate(pipeline(tmp_path), [two], documents=docs)
    assert report.totals()["recall"] == 0.5


def test_a_bad_question_set_is_refused_before_anything_runs(tmp_path, docs):
    p = pipeline(tmp_path)
    with pytest.raises(QuestionSetError, match="question 1: no gold passage"):
        pandion.evaluate(p, [{"question": "Why?"}], documents=docs)
    assert p.index.documents is None   # nothing was indexed


def test_top_k_below_one_is_refused(tmp_path):
    with pytest.raises(ValueError, match="top_k must be at least 1"):
        pandion.evaluate(pipeline(tmp_path), [FOUND], top_k=0)


def test_a_pipeline_without_retrieve_is_refused(tmp_path):
    p = Pipeline(path=tmp_path / "i", parse="pdfium", chunk="recursive_character",
                 embed="fake-deterministic", store="lancedb")
    with pytest.raises(ValueError, match="Add a retrieve section with at least a search step"):
        pandion.evaluate(p, [FOUND])


def test_the_report_as_a_dict_is_plain_json(tmp_path, docs):
    report = pandion.evaluate(pipeline(tmp_path), [FOUND, NOT_IN_DOC], documents=docs)
    data = json.loads(json.dumps(report.to_dict()))
    assert (data["top_k"], data["found"], data["total"]) == (5, 1, 2)
    assert data["questions"][1]["lost_at"] == "parse"
    assert data["questions"][1]["trace"]["steps"][0]["stage"] == "parse"
    assert "retrieval" not in data["questions"][0]
    assert data["by_tag"]["fact"]["found"] == 1


def test_the_report_prints_one_plain_line_per_question_and_the_totals(tmp_path, docs):
    report = pandion.evaluate(pipeline(tmp_path), [FOUND, NOT_IN_DOC], documents=docs)
    assert str(report).splitlines() == [
        "capital found at rank 1",
        "spain missed: lost at parse. Lost at Parse. The answer is not in the text pdfium produced.",
        "Found 1 of 2 (50%). Mean reciprocal rank 0.50.",
    ]


def test_a_failed_question_prints_its_error_and_is_not_counted():
    failed = pandion.QuestionResult(
        id="q7", question="Why?", golds=["Because."], tags=[], found=False, rank=None,
        lost_at=None, trace=None, score={}, error="The search step (dense) failed: no key.",
    )
    assert str(pandion.EvaluationReport(top_k=5, questions=[failed])).splitlines() == [
        "q7 error: The search step (dense) failed: no key.",
        "Found 0 of 0. 1 question could not be scored.",
    ]
