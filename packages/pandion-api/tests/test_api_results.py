"""GET /results/{id}, DELETE /cache and POST /trace."""

import threading
from types import SimpleNamespace

from fastapi import HTTPException

from apihelpers import PIPELINE, finish, make_client, upload
from pandion import IndexPipeline
from pandion_api import Policy


def indexed(client) -> dict:
    sha = upload(client)["sha"]
    state, _ = finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    return state["result"]


def test_a_result_is_described_and_read_by_id(client):
    chunk = indexed(client)["documents"]["report.pdf"]["chunk"]["result_id"]
    info = client.get(f"/results/{chunk}").json()
    assert info["id"] == chunk and info["type"] == "chunk_set"
    assert info["meta"]["transform"] == "recursive_character"
    assert client.get(f"/results/{chunk}/payload").json()["chunks"]


def test_an_index_payload_is_its_descriptor(client):
    index = indexed(client)["index"]["result_id"]
    body = client.get(f"/results/{index}/payload").json()
    assert "dense" in body["backends"] and body["doc_count"] > 0


def test_a_malformed_or_unknown_id_is_404(client):
    for bad in ("0" * 64, "xyz", "..%2F..%2Fetc"):
        assert client.get(f"/results/{bad}").status_code == 404
        assert client.get(f"/results/{bad}/payload").status_code == 404


def test_clearing_the_cache_removes_every_result(client):
    chunk = indexed(client)["documents"]["report.pdf"]["chunk"]["result_id"]
    body = client.delete("/cache").json()
    assert body["results"] >= 3 and body["bytes"] > 0 and body["complete"] is True
    assert client.get(f"/results/{chunk}").status_code == 404
    assert client.delete("/cache").json() == {"results": 0, "bytes": 0, "complete": True}


def test_the_cache_is_not_cleared_while_a_run_works(client, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow_run(self, documents, **kwargs):
        started.set()
        release.wait(5)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", slow_run)
    sha = upload(client)["sha"]
    r = client.post("/runs", json={"config": PIPELINE, "documents": [sha]})
    assert started.wait(5)
    assert client.delete("/cache").status_code == 409
    release.set()
    finish(client, r)


def test_a_policy_can_refuse_to_clear_the_cache(tmp_path):
    class Shared(Policy):
        def check_clear_cache(self, request):
            raise HTTPException(403, "Everyone shares this cache.")

    with make_client(tmp_path, Shared()) as c:
        r = c.delete("/cache")
    assert r.status_code == 403 and r.json()["detail"] == "Everyone shares this cache."


def test_trace_follows_an_answer_down_a_finished_run(client):
    sha = upload(client)["sha"]
    steps = finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))[0]["result"]["documents"]["report.pdf"]
    asked = {"config": PIPELINE, "documents": [sha], "question": "What is the capital of France?", "answer": False}
    search = finish(client, client.post("/ask", json=asked))[0]["result"]["steps"]["search"]["result_id"]
    body = {
        "gold_answers": ["no sentence like this is in the test document"],
        "parse": {"id": steps["parse"]["result_id"], "name": "pdfium"},
        "chunk": steps["chunk"]["result_id"],
        "retrieve": search,
        "final": search,
        "top_k": 3,
    }
    r = client.post("/trace", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["lost_at"] == "parse"
    assert [s["stage"] for s in r.json()["steps"]][0] == "parse"


def test_trace_refuses_an_unknown_result_and_a_question_without_a_sentence(client):
    body = {"gold_answers": ["x"], "parse": {"id": "0" * 64, "name": "p"}, "chunk": "0" * 64, "retrieve": "0" * 64, "final": "0" * 64}
    assert client.post("/trace", json=body).status_code == 404
    assert client.post("/trace", json={**body, "gold_answers": [" "]}).status_code == 422
