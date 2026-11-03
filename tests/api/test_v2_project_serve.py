"""POST /api/v2/projects/serve on the playground app: pandion-api's route, under the playground's Policy."""

from __future__ import annotations

from playground.backend import demo

CONFIG = {
    "categories": {"contracts": {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"}}},
    "route": [{"category": "contracts"}],
    "index": {"embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}},
    "retrieve": {"search": {"use": "dense", "top_k": 3}},
    "answer": {"use": "search"},
}


def questions(count: int) -> dict:
    return {"questions": [{"id": f"q{n}", "question": f"Question {n}?", "gold_answers": ["Yes."]} for n in range(count)]}


def export(client, count: int):
    body = {"config": CONFIG, "name": "x", "categories": {"contracts": {"questions": questions(count)}}}
    return client.post("/api/v2/projects/serve?preview=1", json=body)


def test_serve_export_is_reachable_on_the_playground_app(client):
    r = export(client, 2)
    assert r.status_code == 200 and "serve.py" in r.json()["files"]


def test_demo_caps_the_questions_in_a_serve_export(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    ok = export(client, demo.MAX_EVALUATION_QUESTIONS)
    assert ok.status_code == 200, ok.text
    r = export(client, demo.MAX_EVALUATION_QUESTIONS + 1)
    assert r.status_code == 413
    assert f"at most {demo.MAX_EVALUATION_QUESTIONS} questions" in r.json()["detail"]
