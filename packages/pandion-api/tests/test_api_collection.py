"""Evaluations and comparisons name the index collection they searched."""

import re

from apihelpers import PIPELINE, finish, upload
from pandion import StageResult
from pandion_api import reports

SHAPE = re.compile(r"^[0-9a-f]{16}-[0-9a-f]{12}$")
QUESTIONS = [
    {"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}
]
VARIANTS = [
    {"use": "recursive_character", "chunk_size": 70},
    {"use": "recursive_character", "chunk_size": 200},
]


def evaluate(client, sha, config=PIPELINE):
    body = {"config": config, "documents": [sha], "questions": QUESTIONS, "top_k": 3}
    state, _ = finish(client, client.post("/evaluations", json=body))
    return state["result"]


def compare(client, sha, **extra):
    body = {"config": PIPELINE, "documents": [sha], "stage": "chunk", "variants": VARIANTS, **extra}
    state, _ = finish(client, client.post("/comparisons", json=body))
    return state["result"]


def test_evaluation_result_names_the_index_collection(client):
    result = evaluate(client, upload(client)["sha"])
    assert SHAPE.match(result["index_collection"])


def test_two_evaluations_of_the_same_documents_and_recipe_name_the_same_collection(client):
    sha = upload(client)["sha"]
    assert evaluate(client, sha)["index_collection"] == evaluate(client, sha)["index_collection"]


def test_a_different_chunker_names_a_different_collection(client):
    sha = upload(client)["sha"]
    a, b = (c["index_collection"] for c in compare(client, sha, questions=QUESTIONS)["comparisons"])
    assert SHAPE.match(a) and SHAPE.match(b) and a != b


def test_each_comparison_variant_names_its_collection(client):
    result = compare(client, upload(client)["sha"])
    assert all(SHAPE.match(c["index_collection"]) for c in result["comparisons"])


def test_a_one_question_comparison_names_the_collection(client):
    result = compare(client, upload(client)["sha"], question="What is the capital of France?")
    assert all(SHAPE.match(c["index_collection"]) for c in result["comparisons"])


def test_a_run_that_fails_before_indexing_names_none():
    failed = StageResult(stage="index", transform="lancedb", status="failed", output=None)
    assert reports.collection_of(failed) is None
    assert reports.collection_of(None) is None


def test_a_comparison_stopped_before_the_index_names_none(client):
    result = compare(client, upload(client)["sha"], through="chunk")
    assert all(c["index_collection"] is None for c in result["comparisons"])
