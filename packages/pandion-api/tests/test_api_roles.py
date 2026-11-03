"""Lab mode has no end users: its routes run as admin, so a pipeline with an
`access:` block is searched, answered and evaluated, not refused."""

from apihelpers import PIPELINE, finish, upload

ACCESS = {**PIPELINE, "access": {"default": ["staff"]}}
VARIANTS = [
    {"use": "recursive_character", "chunk_size": 70},
    {"use": "recursive_character", "chunk_size": 200},
]
QUESTION = "What is the capital of France?"
QUESTIONS = [{"id": "capital", "question": QUESTION, "gold_answer": "The capital of France is Paris."}]


def test_lab_ask_with_an_access_block_runs_as_admin(client):
    sha = upload(client)["sha"]
    body = {"config": ACCESS, "documents": [sha], "question": QUESTION}
    state, _ = finish(client, client.post("/ask", json=body))
    assert state["ok"] is True and state["result"]["text"]


def test_lab_retrieve_with_an_access_block_runs_as_admin(client):
    sha = upload(client)["sha"]
    body = {"config": ACCESS, "documents": [sha], "question": QUESTION, "answer": False}
    state, _ = finish(client, client.post("/ask", json=body))
    assert state["ok"] is True and state["result"]["hits"]


def test_lab_evaluation_with_an_access_block_runs(client):
    sha = upload(client)["sha"]
    body = {"config": ACCESS, "documents": [sha], "questions": QUESTIONS, "top_k": 3}
    state, _ = finish(client, client.post("/evaluations", json=body))
    assert state["ok"] is True
    assert state["result"]["questions"][0]["found"] is True


def test_lab_run_without_an_access_block_is_unchanged(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "documents": [sha], "question": QUESTION}
    state, _ = finish(client, client.post("/ask", json=body))
    assert state["ok"] is True


def test_lab_comparison_with_an_access_block_runs(client):
    sha = upload(client)["sha"]
    base = {"config": ACCESS, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
    state, _ = finish(client, client.post("/comparisons", json={**base, "questions": QUESTIONS}))
    assert state["ok"] is True
    state, _ = finish(client, client.post("/comparisons", json={**base, "question": QUESTION}))
    assert state["ok"] is True
    assert all(c["ok"] for c in state["result"]["comparisons"])
