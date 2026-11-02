"""Serve's /conversations and /memories: the owner only, and the limit on every call."""

import pytest
from fastapi import HTTPException

from pandion.extend import Memory, Turn
from pandion_api import Policy
from apihelpers import make_serve_client
from test_api_chat import ByHeader, StubPipeline, serve


def put(c, user, conversation_id, question="Q?", answer="A.", at="2026-01-01T00:00:00+00:00"):
    c.app.state.conversations.append(
        conversation_id, user, Turn(question=question, answer=answer, rewrite="SECRET", source_ids=["c1"], trace_id="t1", created_at=at)
    )


def test_list_shows_only_the_users_conversations_newest_first(tmp_path):
    with serve(tmp_path, StubPipeline(), ByHeader()) as c:
        put(c, "ann", "old", "First?")
        put(c, "bob", "bobs", "Bob?")
        put(c, "ann", "new", "Second?", at="2026-02-01T00:00:00+00:00")
        rows = c.get("/conversations", headers={"x-user": "ann"}).json()
    assert [r["id"] for r in rows] == ["new", "old"] and rows[0]["title"] == "Second?" and rows[0]["turns"] == 1


def test_get_returns_the_turns_in_order_without_the_rewrite(tmp_path):
    with serve(tmp_path, StubPipeline()) as c:
        put(c, "anonymous", "c", "One?", "Uno.")
        put(c, "anonymous", "c", "Two?", "Dos.")
        r = c.get("/conversations/c")
    body = r.json()
    assert [t["question"] for t in body["turns"]] == ["One?", "Two?"]
    assert body["turns"][0]["source_ids"] == ["c1"] and body["turns"][0]["trace_id"] == "t1"
    assert "SECRET" not in r.text and "rewrite" not in r.text and "summary" not in r.text


def test_another_users_conversation_is_a_404_everywhere(tmp_path):
    with serve(tmp_path, StubPipeline(), ByHeader()) as c:
        put(c, "bob", "bobs")
        ann = {"x-user": "ann"}
        assert c.get("/conversations/bobs", headers=ann).status_code == 404
        assert c.delete("/conversations/bobs", headers=ann).status_code == 404
        chat = c.post("/chat", json={"messages": [{"role": "user", "content": "Hi"}], "conversation_id": "bobs"}, headers=ann)
        assert chat.status_code == 404
        assert c.app.state.conversations.load("bobs", "bob") is not None


def test_delete_removes_the_conversation_and_a_second_delete_is_404(tmp_path):
    with serve(tmp_path, StubPipeline()) as c:
        put(c, "anonymous", "c")
        assert c.delete("/conversations/c").status_code == 204
        assert c.get("/conversations/c").status_code == 404
        assert c.delete("/conversations/c").status_code == 404


def add_memory(c, user, text):
    store = c.app.state.conversations
    store.add_memory(user, Memory(text=text))
    return [m for m in store.memories(user) if m.text == text][0].id


def test_memories_list_and_delete_for_the_owner_only(tmp_path):
    with serve(tmp_path, StubPipeline(), ByHeader(), memory=True) as c:
        mine, theirs = add_memory(c, "ann", "Likes tea."), add_memory(c, "bob", "Likes coffee.")
        ann = {"x-user": "ann"}
        assert [m["text"] for m in c.get("/memories", headers=ann).json()] == ["Likes tea."]
        assert c.delete(f"/memories/{theirs}", headers=ann).status_code == 404
        assert c.delete(f"/memories/{mine}", headers=ann).status_code == 204
        assert c.delete(f"/memories/{mine}", headers=ann).status_code == 404
        assert c.get("/memories", headers=ann).json() == []
        assert len(c.app.state.conversations.memories("bob")) == 1


def test_memories_written_while_on_can_still_be_seen_and_deleted_when_off(tmp_path):
    with serve(tmp_path, StubPipeline(), memory=True) as c:
        add_memory(c, "anonymous", "Likes tea.")
        store = c.app.state.conversations
    with make_serve_client(tmp_path, indexed=False, store=store) as off:
        rows = off.get("/memories").json()
        assert [m["text"] for m in rows] == ["Likes tea."]
        assert off.delete(f"/memories/{rows[0]['id']}").status_code == 204
        assert off.get("/memories").json() == []


class Refusing(Policy):
    def limit(self, request):
        raise HTTPException(status_code=429, detail="Slow down.")

    def user_id(self, request):
        raise HTTPException(status_code=401, detail="Who are you?")


def test_limit_is_asked_before_user_id(tmp_path):
    with serve(tmp_path, StubPipeline(), Refusing()) as c:
        assert c.get("/conversations").status_code == 429


class Counting(Policy):
    def __init__(self):
        self.limited = 0

    def limit(self, request):
        self.limited += 1


@pytest.mark.parametrize("method,path", [
    ("get", "/conversations"), ("get", "/conversations/x"), ("delete", "/conversations/x"),
    ("get", "/memories"), ("delete", "/memories/x"),
])
def test_every_route_calls_the_policy_limit(tmp_path, method, path):
    policy = Counting()
    with serve(tmp_path, StubPipeline(), policy, memory=True) as c:
        getattr(c, method)(path)
    assert policy.limited == 1
