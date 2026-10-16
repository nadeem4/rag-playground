"""POST /ask: search the documents for a question, or answer it, as a run."""

from apihelpers import PIPELINE, finish, upload
from pdfs import build_pdf

QUESTION = "What is the capital of France?"


def ask(client, sha, **extra):
    body = {"config": PIPELINE, "documents": [sha], "question": QUESTION, **extra}
    return finish(client, client.post("/ask", json=body))


def test_retrieve_gives_the_hits_and_each_steps_result(client):
    sha = upload(client)["sha"]
    state, events = ask(client, sha, answer=False)
    result = state["result"]
    assert state["kind"] == "retrieve" and result["ok"] is True
    assert 0 < len(result["hits"]) <= 3
    assert result["steps"]["search"]["strategy"] == "dense"
    assert result["steps"]["rerank"] == []
    assert len(result["index"]["result_id"]) == 64
    assert "answer" not in result
    assert events[-1]["event"] == "stream_end"


def test_ask_gives_the_answer_and_its_text(client):
    sha = upload(client)["sha"]
    state, _ = ask(client, sha)
    result = state["result"]
    assert state["kind"] == "ask" and result["ok"] is True
    assert result["answer"]["strategy"] == "search"
    assert result["text"] and result["output"]["kind"] == "search"


def test_k_sets_how_many_hits_come_back(client):
    sha = upload(client)["sha"]
    state, _ = ask(client, sha, answer=False, k=1)
    assert len(state["result"]["hits"]) == 1


def test_an_indexed_document_is_read_from_the_cache(client):
    sha = upload(client)["sha"]
    finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    state, _ = ask(client, sha, answer=False)
    assert state["result"]["index"]["status"] == "cached"


def test_a_pipeline_that_cannot_answer_is_a_problem_before_anything_runs(client):
    sha = upload(client)["sha"]
    no_answer = {k: v for k, v in PIPELINE.items() if k != "answer"}
    r = client.post("/ask", json={"config": no_answer, "documents": [sha], "question": QUESTION})
    assert r.status_code == 422 and "answer" in r.json()["detail"]["problems"][0]
    r = client.post("/ask", json={"config": no_answer, "documents": [sha], "question": QUESTION, "answer": False})
    assert r.status_code == 202
    index_only = {"index": PIPELINE["index"]}
    r = client.post("/ask", json={"config": index_only, "documents": [sha], "question": QUESTION, "answer": False})
    assert r.status_code == 422 and "retrieve" in r.json()["detail"]["problems"][0]


def test_an_empty_question_or_a_bad_k_is_422(client):
    sha = upload(client)["sha"]
    assert client.post("/ask", json={"config": PIPELINE, "documents": [sha], "question": ""}).status_code == 422
    assert client.post("/ask", json={"config": PIPELINE, "documents": [sha], "question": "x", "k": 0}).status_code == 422


def test_a_question_too_long_or_a_k_too_large_is_422(client):
    sha = upload(client)["sha"]
    asked = {"config": PIPELINE, "documents": [sha]}
    assert client.post("/ask", json={**asked, "question": "x" * 2001}).status_code == 422
    assert client.post("/ask", json={**asked, "question": "x", "k": 101}).status_code == 422


def test_a_document_id_is_matched_whole():
    from pandion_api.documents import SHA

    assert SHA.match("a" * 64)
    assert not SHA.match("a" * 64 + "\n") and not SHA.match("x" + "a" * 64)


def test_where_is_passed_through_to_the_search(client):
    report = upload(client)["sha"]
    short = upload(client, "short.pdf", build_pdf([["Paris is the capital of France."]]))["sha"]
    body = {"config": PIPELINE, "documents": [report, short], "question": QUESTION, "answer": False}

    state, _ = finish(client, client.post("/ask", json={**body, "where": {"document": [short], "pages": [1, 1]}}))

    hits = state["result"]["hits"]
    assert state["result"]["ok"] is True and hits
    assert {hit["chunk"]["doc_id"] for hit in hits} == {short}
    answered, _ = finish(client, client.post("/ask", json={**body, "answer": True, "where": {"document": [short]}}))
    assert {hit["chunk"]["doc_id"] for hit in answered["result"]["hits"]} == {short}


def test_a_bad_where_is_422(client):
    sha = upload(client)["sha"]
    asked = {"config": PIPELINE, "documents": [sha], "question": QUESTION}
    for where in (
        {"sql": "1=1"},
        {"pages": [1]},
        {"pages": [3, 1]},
        {"pages": ["1", "2"]},
        {"pages": [1.5, 2]},
        {"pages": [1, 10**20]},
        {"section": 3},
        {"document": []},
        {"document": ["b" * 64]},
        "doc_id = 'x'",
    ):
        r = client.post("/ask", json={**asked, "where": where})
        assert r.status_code == 422, where
