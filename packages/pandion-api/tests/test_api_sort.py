"""Pins, labels and POST /pipelines/sort."""

import json

from apihelpers import PIPELINE, finish, make_client, upload
from pandion_api import Policy
from pdfs import build_pdf


def chunker(size):
    return {"use": "recursive_character", "chunk_size": size, "chunk_overlap": 10}


CONFIG = {
    "categories": {
        "reports": {"parse": {"use": "pdfium"}, "chunk": chunker(70)},
        "scans": {"parse": {"use": "pdfium"}, "chunk": chunker(40)},
    },
    "route": [
        {"when": {"use": "metadata", "key": "kind", "equals": "scan"}, "category": "scans"},
        {"when": {"use": "path", "pattern": "https://**"}, "category": "scans"},
        {"category": "reports"},
    ],
    "index": {"embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}},
    "retrieve": PIPELINE["retrieve"],
    "answer": PIPELINE["answer"],
}
QUESTIONS = [
    {"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}
]
QUESTION = "What is the capital of France?"


def chunk_id(events):
    """The id of report.pdf's chunk step, from the first event that finished it."""
    return next(e["artifact_id"] for e in events if e["event"] == "node_finished" and e["node_id"] == "report.pdf::chunk")


def run(client, sha, **extra):
    return finish(client, client.post("/runs", json={"config": CONFIG, "documents": [sha], **extra}))


def test_run_with_a_pin_uses_it(client):
    sha = upload(client)["sha"]
    state, events = run(client, sha, categories={sha: "scans"})
    assert state["result"]["categories"]["report.pdf"] == {"category": "scans", "reason": "Chosen when added"}
    assert chunk_id(events) != chunk_id(run(client, sha)[1])


def test_ask_and_evaluate_agree_with_the_run_about_pins(client):
    sha = upload(client)["sha"]
    pin = {"categories": {sha: "scans"}}
    wanted = chunk_id(run(client, sha, **pin)[1])
    base = {"config": CONFIG, "documents": [sha], **pin}
    _, ask = finish(client, client.post("/ask", json={**base, "question": QUESTION}))
    _, evaluation = finish(client, client.post("/evaluations", json={**base, "questions": QUESTIONS}))
    _, comparison = finish(
        client,
        client.post(
            "/comparisons",
            json={**base, "stage": "embed", "variants": [{"use": "fake-deterministic"}], "questions": QUESTIONS},
        ),
    )
    assert chunk_id(ask) == chunk_id(evaluation) == chunk_id(comparison) == wanted


def test_pin_for_a_document_not_sent_is_a_422(client):
    sha = upload(client)["sha"]
    other = "1" * 64
    r = client.post("/runs", json={"config": CONFIG, "documents": [sha], "categories": {other: "scans"}})
    assert r.status_code == 422 and other in r.json()["detail"]["problems"][0]


def test_unknown_category_is_a_422_listing_categories(client):
    sha = upload(client)["sha"]
    r = client.post("/runs", json={"config": CONFIG, "documents": [sha], "categories": {sha: "memos"}})
    assert r.status_code == 422
    text = r.json()["detail"]["problems"][0]
    assert "memos" in text and "reports" in text and "scans" in text


def test_labels_route_a_document(client):
    sha = upload(client)["sha"]
    state, _ = run(client, sha, metadata={sha: {"kind": "scan"}})
    assert state["result"]["categories"]["report.pdf"] == {
        "category": "scans",
        "reason": "Rule 1: metadata kind equals scan",
    }


def sort(client, sha, **extra):
    return client.post("/pipelines/sort", json={"config": CONFIG, "documents": [sha], **extra})


def test_sort_previews_without_running(client, tmp_path):
    sha = upload(client)["sha"]
    r = sort(client, sha, metadata={sha: {"kind": "scan"}})
    assert r.status_code == 200
    assert r.json() == {
        "documents": {sha: {"category": "scans", "reason": "Rule 1: metadata kind equals scan"}}
    }
    assert client.app.state.runs.active() == []
    assert not (tmp_path / "data" / "artifacts").exists()
    pinned = sort(client, sha, categories={sha: "reports"}).json()
    assert pinned["documents"][sha] == {"category": "reports", "reason": "Chosen when added"}


def test_sort_of_a_url_document_uses_its_link_as_path(client):
    sha = upload(client, "page.pdf", build_pdf([["A linked page."]]))["sha"]
    store = client.app.state.documents
    with store.lock:
        store.write(sha, "page.pdf", 1, "application/pdf", "https://example.com/papers/page.pdf")
    got = sort(client, sha).json()["documents"][sha]
    assert got == {"category": "scans", "reason": "Rule 2: path matches https://**"}


def test_sort_respects_the_policy(tmp_path):
    class Refuse(Policy):
        def check_run(self, config, request):
            from fastapi import HTTPException

            raise HTTPException(status_code=403, detail="no")

    with make_client(tmp_path, Refuse()) as c:
        sha = upload(c)["sha"]
        assert sort(c, sha).status_code == 403
        assert json.loads(c.post("/pipelines/sort", json={"config": CONFIG, "documents": [sha]}).text)["detail"] == "no"
