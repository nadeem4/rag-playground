"""POST /ask in serve mode: a one-turn answer that stores nothing."""

import pytest

from apihelpers import make_serve_client
from pandion_api import Policy
from test_api_chat import StubPipeline, serve


class Counting(Policy):
    def __init__(self):
        self.limited = 0

    def limit(self, request):
        self.limited += 1

    def roles(self, request):
        return ["hr"]


def test_ask_answers_without_creating_a_conversation(tmp_path):
    with serve(tmp_path, StubPipeline()) as c:
        r = c.post("/ask", json={"question": "Notice period?"})
        body = r.json()
        stored = c.app.state.conversations.list("anonymous")
    assert r.status_code == 200 and body["ok"] is True and body["text"] and body["trace_id"]
    assert body["sources"][0]["id"] == "c1" and body["conversation_id"] is None
    assert stored == []


def test_ask_uses_the_policy_roles_and_limit(tmp_path):
    stub, policy = StubPipeline(), Counting()
    with serve(tmp_path, stub, policy) as c:
        c.post("/ask", json={"question": "Notice period?"})
    assert stub.asked[0]["roles"] == ["hr"] and policy.limited == 1


def test_a_failed_answer_is_ok_false_with_one_sentence(tmp_path):
    with serve(tmp_path, StubPipeline(ok=False)) as c:
        body = c.post("/ask", json={"question": "Notice period?"}).json()
    assert body["ok"] is False and body["text"] == "" and body["error"]


@pytest.mark.parametrize("question", ["", "x" * 8001])
def test_ask_rejects_an_empty_or_huge_question(tmp_path, question):
    with serve(tmp_path, StubPipeline()) as c:
        assert c.post("/ask", json={"question": question}).status_code == 422


def test_lab_ask_is_not_mounted_in_serve(tmp_path):
    with make_serve_client(tmp_path) as c:
        r = c.post("/ask", json={"config": {}, "documents": []})
    assert r.status_code == 422
