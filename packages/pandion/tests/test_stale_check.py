"""stale_check: an expected passage that is not in the current parse is a stale question, not a retrieval miss."""

from __future__ import annotations

import json

import pytest

from pandion import Pipeline
from pandion.evaluation import StaleCheck, stale_check
from pdfs import SAMPLE_PAGES, build_pdf

PARIS = {"id": "capital", "question": "What is the capital of France?", "gold_answer": "The capital of France is Paris."}
GONE = {"id": "spain", "question": "What is the capital of Spain?", "gold_answer": "Madrid is the capital of Spain."}
GONE_TOO = {"id": "italy", "question": "What is the capital of Italy?", "gold_answer": "Rome is the capital of Italy."}
OTHER_DOC = [["Bees dance to show the hive where the flowers are."]]


def pipeline(tmp_path, chunk_size=70):
    return Pipeline(
        path=tmp_path / "index", parse="pdfium",
        chunk={"use": "recursive_character", "chunk_size": chunk_size, "chunk_overlap": 0},
        embed="fake-deterministic", store="lancedb", search={"use": "dense", "top_k": 3},
    )


@pytest.fixture
def docs(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "sample.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return folder


def test_a_passage_in_the_document_is_not_stale(tmp_path, docs):
    check = stale_check(pipeline(tmp_path), [PARIS], documents=docs)
    assert check.ok and check.stale == [] and check.warnings == []


def test_every_missing_passage_is_listed_by_question_id(tmp_path, docs):
    check = stale_check(pipeline(tmp_path), [GONE, PARIS, GONE_TOO], documents=docs)
    assert not check.ok and check.stale == ["spain", "italy"]
    assert str(check) == (
        "The question set is stale: 2 expected passages are not in the current parse of the documents: "
        "spain, italy. Fix or rewrite those questions; this is not a retrieval regression."
    )


def test_a_question_without_an_id_is_named_by_its_position(tmp_path, docs):
    check = stale_check(pipeline(tmp_path), [PARIS, {**GONE, "id": ""}], documents=docs)
    assert check.stale == ["question 2"]


def test_a_question_naming_a_document_is_checked_in_that_document_only(tmp_path, docs):
    (docs / "bees.pdf").write_bytes(build_pdf(OTHER_DOC))
    p = pipeline(tmp_path)
    assert stale_check(p, [{**PARIS, "document": "sample.pdf"}], documents=docs).ok
    assert stale_check(p, [{**PARIS, "document": "bees.pdf"}], documents=docs).stale == ["capital"]


def test_a_passage_longer_than_any_piece_warns_and_is_not_stale(tmp_path, docs):
    check = stale_check(pipeline(tmp_path, chunk_size=30), [PARIS], documents=docs)
    assert check.ok
    assert check.warnings == [
        "capital: the expected passage is 31 characters, longer than the biggest piece (30), so it can never be found."
    ]


def test_a_document_that_does_not_parse_is_an_error_naming_it(tmp_path, docs):
    (docs / "broken.pdf").write_bytes(b"%PDF-1.4 not a pdf")
    with pytest.raises(ValueError, match="broken.pdf"):
        stale_check(pipeline(tmp_path), [PARIS], documents=docs)


def test_it_does_not_search(tmp_path, docs, monkeypatch):
    p = pipeline(tmp_path)
    monkeypatch.setattr(type(p.retrieval), "_retrieve", lambda *a, **k: pytest.fail("searched"))
    stale_check(p, [PARIS], documents=docs)


def test_to_dict_is_json():
    data = StaleCheck(stale=["a"], warnings=["w"]).to_dict()
    assert json.loads(json.dumps(data)) == {"stale": ["a"], "warnings": ["w"]}
