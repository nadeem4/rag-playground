"""POST /evaluations and POST /comparisons: part 2's features, as runs."""

import json

from fastapi import HTTPException

from apihelpers import PIPELINE, finish, make_client, upload
from pandion_api import Policy

QUESTIONS = [
    {"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}
]
VARIANTS = [
    {"use": "recursive_character", "chunk_size": 70},
    {"use": "recursive_character", "chunk_size": 200},
]


def test_an_evaluation_reports_each_question_and_the_totals(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "documents": [sha], "questions": QUESTIONS, "top_k": 3}
    state, events = finish(client, client.post("/evaluations", json=body))
    result = state["result"]
    assert state["kind"] == "evaluation" and state["ok"] is True
    assert result["top_k"] == 3 and result["total"] == 1 and result["cancelled"] is False
    assert result["questions"][0]["id"] == "capital" and "found" in result["questions"][0]
    assert any(e["event"] == "question_finished" for e in events)


def test_a_bad_question_set_is_400_before_anything_runs(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "documents": [sha], "questions": [{"question": "No gold passage?"}]}
    r = client.post("/evaluations", json=body)
    assert r.status_code == 400 and r.json()["detail"]


def test_a_pipeline_without_a_search_step_cannot_be_evaluated(client):
    sha = upload(client)["sha"]
    body = {"config": {"index": PIPELINE["index"]}, "documents": [sha], "questions": QUESTIONS}
    assert client.post("/evaluations", json=body).status_code == 422


def test_without_questions_the_documents_kept_set_is_used(client):
    sha = upload(client)["sha"]
    kept = json.dumps({"questions": QUESTIONS}).encode()
    assert client.post(f"/documents/{sha}/questions", files={"file": ("q.json", kept, "application/json")}).status_code == 200
    state, _ = finish(client, client.post("/evaluations", json={"config": PIPELINE, "documents": [sha]}))
    assert state["ok"] is True and [q["id"] for q in state["result"]["questions"]] == ["capital"]


def test_without_questions_and_no_kept_set_an_evaluation_is_400(client):
    sha = upload(client)["sha"]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha]})
    assert r.status_code == 400 and "question" in r.json()["detail"]


def test_a_question_set_in_the_request_is_capped_like_an_upload(client):
    sha = upload(client)["sha"]
    many = [{"question": f"Question {n}?", "gold_answers": ["Paris."]} for n in range(501)]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": many})
    assert r.status_code == 400 and "500" in r.json()["detail"]
    golds = [{"question": "Where?", "gold_answers": [f"Passage {n}." for n in range(21)]}]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": golds})
    assert r.status_code == 400 and "20" in r.json()["detail"]
    huge = [{"question": "Where?", "gold_answers": ["x" * (1024 * 1024)]}]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": huge})
    assert r.status_code == 413


def test_a_comparison_runs_each_variant_and_names_the_best(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "questions": QUESTIONS}
    state, _ = finish(client, client.post("/comparisons", json=body))
    result = state["result"]
    assert state["kind"] == "comparison" and state["ok"] is True
    assert len(result["comparisons"]) == 2 and isinstance(result["best"], list)
    assert [c["variant"]["chunk_size"] for c in result["comparisons"]] == [70, 200]


def test_a_comparison_without_questions_gives_each_variants_step(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
    state, _ = finish(client, client.post("/comparisons", json=body))
    assert [c["ok"] for c in state["result"]["comparisons"]] == [True, True]


def test_what_cannot_be_compared_is_400_before_anything_runs(client):
    sha = upload(client)["sha"]
    base = {"config": PIPELINE, "variants": VARIANTS, "documents": [sha]}
    assert client.post("/comparisons", json={**base, "stage": "answer"}).status_code == 400
    search = {**base, "stage": "search", "variants": [{"use": "dense"}, {"use": "bm25"}]}
    r = client.post("/comparisons", json=search)
    assert r.status_code == 400 and "questions" in r.json()["detail"]
    assert client.post("/comparisons", json={**base, "stage": "chunk", "variants": VARIANTS * 6}).status_code == 422


def test_the_policy_sets_how_many_variants_one_comparison_may_have(tmp_path):
    class Two(Policy):
        def max_variants(self, request):
            return 2

    with make_client(tmp_path, Two()) as c:
        sha = upload(c)["sha"]
        body = {"config": PIPELINE, "stage": "chunk", "variants": [*VARIANTS, VARIANTS[0]], "documents": [sha]}
        r = c.post("/comparisons", json=body)
    assert r.status_code == 422 and "at most 2" in r.json()["detail"]["problems"][0]


def test_a_variant_the_policy_refuses_is_refused_before_anything_runs(tmp_path):
    class NoBigPieces(Policy):
        def check_run(self, config, request):
            if config["index"]["chunk"].get("chunk_size", 0) > 100:
                raise HTTPException(403, "Pieces stay small here.")

    with make_client(tmp_path, NoBigPieces()) as c:
        sha = upload(c)["sha"]
        body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
        r = c.post("/comparisons", json=body)
    assert r.status_code == 403 and r.json()["detail"] == "Pieces stay small here."
