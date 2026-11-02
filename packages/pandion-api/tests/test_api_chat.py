"""POST /chat in serve mode: the answer, the events, the owner, the roles, the limit, the disconnect."""

import asyncio
import json
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from apihelpers import make_serve_client
from pandion.chat_turn import ChatSettings
from pandion.llm import Completion
from pandion_api import Policy, ServeSettings


def answer(text="The notice period is 30 days.", ok=True):
    hit = SimpleNamespace(chunk=SimpleNamespace(id="c1", doc_id="lease.pdf", page_span=(2, 3)), score=0.5)
    payload = {"answer": [{"text": text}], "citations": [{"chunk_id": "c1"}]}
    return SimpleNamespace(
        ok=ok, text=text if ok else "", output=SimpleNamespace(payload=payload) if ok else None,
        hits=[hit] if ok else [], cost=lambda: {"seconds": 0.1},
    )


class StubPipeline:
    def __init__(self, **kwargs):
        self.asked, self.kwargs = [], kwargs

    def ask(self, question, **kwargs):
        self.asked.append({"question": question, **kwargs})
        return answer(**self.kwargs)


class ByHeader(Policy):
    def user_id(self, request):
        return request.headers.get("x-user", "anonymous")

    def roles(self, request):
        return ["hr"]


@pytest.fixture
def rewrites(monkeypatch):
    calls = []

    def fake(model, **kwargs):
        calls.append(kwargs)
        return Completion(text="What is the notice period in the lease?", usage={}, stop_reason="end_turn")

    monkeypatch.setattr("pandion.llm.complete", fake)
    return calls


def serve(tmp_path, stub=None, policy=None, **settings):
    client = make_serve_client(tmp_path, policy, indexed=False, serve=ServeSettings(chat=ChatSettings(**settings)))
    if stub is not None:
        client.app.state.pipeline = stub
    return client


def say(client, text="Notice period?", **extra):
    return client.post("/chat", json={"messages": [{"role": "user", "content": text}], **extra})


def events_of(text):
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]


def test_chat_returns_text_sources_and_a_conversation_id(tmp_path):
    with serve(tmp_path, StubPipeline()) as c:
        r = say(c)
    body = r.json()
    assert r.status_code == 200 and body["ok"] is True
    assert body["text"] == "The notice period is 30 days." and body["conversation_id"] and body["trace_id"]
    assert body["sources"] == [{"id": "c1", "document": "lease.pdf", "pages": [2, 3], "score": 0.5}]


def test_a_real_pipeline_answers_from_the_index(tmp_path):
    with make_serve_client(tmp_path) as c:
        body = say(c, "What is the capital of France?").json()
    assert body["ok"] is True and body["text"] and body["sources"]


def test_stream_sends_rewrite_sources_token_done_in_order(tmp_path):
    with serve(tmp_path, StubPipeline()) as c:
        r = say(c, stream=True)
    assert r.headers["content-type"].startswith("text/event-stream")
    events = events_of(r.text)
    assert [e["event"] for e in events] == ["chat_rewrite", "sources", "token", "done", "stream_end"]
    assert events[2]["text"] == "The notice period is 30 days."
    done = events[3]
    assert done["ok"] is True and done["conversation_id"] and done["trace_id"] and "cost" in done and "timings" in done


def test_a_second_message_with_the_id_continues_the_conversation(tmp_path, rewrites):
    with serve(tmp_path, StubPipeline()) as c:
        first = say(c, "Tell me about the lease").json()
        second = say(c, "And the notice?", conversation_id=first["conversation_id"]).json()
        assert second["conversation_id"] == first["conversation_id"]
        turns = c.app.state.conversations.load(first["conversation_id"], "anonymous").turns
    assert [t.question for t in turns] == ["Tell me about the lease", "And the notice?"]


def test_only_the_last_user_message_is_the_question(tmp_path, rewrites):
    stub = StubPipeline()
    with serve(tmp_path, stub) as c:
        first = say(c).json()
        r = c.post("/chat", json={
            "conversation_id": first["conversation_id"],
            "messages": [
                {"role": "user", "content": "EARLIER-USER"},
                {"role": "assistant", "content": "LEAKED-ASSISTANT"},
                {"role": "user", "content": "And the notice?"},
            ],
        })
    assert r.status_code == 200
    assert "LEAKED-ASSISTANT" not in json.dumps(stub.asked, default=str) and "EARLIER-USER" not in json.dumps(stub.asked, default=str)
    assert "LEAKED-ASSISTANT" not in rewrites[0]["user"] and "And the notice?" in rewrites[0]["user"]


def test_the_last_message_must_be_from_the_user(tmp_path):
    with serve(tmp_path, StubPipeline()) as c:
        r = c.post("/chat", json={"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]})
    assert r.status_code == 422


def test_roles_from_the_policy_reach_the_search(tmp_path):
    stub = StubPipeline()
    with serve(tmp_path, stub, ByHeader()) as c:
        say(c)
    assert stub.asked[0]["roles"] == ["hr"]


def test_user_id_from_the_policy_owns_the_conversation(tmp_path):
    stub = StubPipeline()
    with serve(tmp_path, stub, ByHeader()) as c:
        mine = c.post("/chat", json={"messages": [{"role": "user", "content": "Q?"}]}, headers={"x-user": "ann"}).json()
        r = c.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "Q?"}], "conversation_id": mine["conversation_id"]},
            headers={"x-user": "bob"},
        )
    assert r.status_code == 404 and len(stub.asked) == 1


def test_limit_refusal_is_returned_and_nothing_runs(tmp_path):
    class Full(Policy):
        def limit(self, request):
            raise HTTPException(status_code=429, detail="Too many questions. Try again later.")

    stub = StubPipeline()
    with serve(tmp_path, stub, Full()) as c:
        r = say(c)
    assert r.status_code == 429 and r.json()["detail"] == "Too many questions. Try again later."
    assert stub.asked == []


def test_a_disconnect_cancels_the_turn(tmp_path):
    seen, started, finished = {}, threading.Event(), threading.Event()

    class Slow(StubPipeline):
        def ask(self, question, **kwargs):
            seen["cancel"] = kwargs["cancel"]
            started.set()
            cancelled = kwargs["cancel"].wait(5)
            finished.set()
            return answer(ok=not cancelled)

    with serve(tmp_path, Slow()) as c:
        app = c.app
        body = json.dumps({"messages": [{"role": "user", "content": "Q?"}], "stream": True}).encode()

        async def scenario():
            sent_body = False

            async def receive():
                nonlocal sent_body
                if not sent_body:
                    sent_body = True
                    return {"type": "http.request", "body": body, "more_body": False}
                await asyncio.to_thread(started.wait, 5)
                await asyncio.sleep(0.1)
                return {"type": "http.disconnect"}

            async def send(message):
                pass

            scope = {
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
                "path": "/chat", "raw_path": b"/chat", "root_path": "", "query_string": b"", "server": ("t", 80),
                "client": ("c", 1), "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
            await app(scope, receive, send)
            await asyncio.to_thread(finished.wait, 5)

        asyncio.run(scenario())
        assert seen["cancel"].is_set()
        assert app.state.conversations.list("anonymous") == []


def test_a_failed_answer_is_ok_false_with_no_stored_turn(tmp_path):
    with serve(tmp_path, StubPipeline(ok=False)) as c:
        r = say(c)
        assert c.app.state.conversations.list("anonymous") == []
    body = r.json()
    assert r.status_code == 200 and body["ok"] is False and body["text"] == ""
    assert body["error"] and "Traceback" not in body["error"]


def test_a_crash_in_the_turn_is_a_generic_sentence(tmp_path):
    class Crash(StubPipeline):
        def ask(self, question, **kwargs):
            raise RuntimeError("secret detail at C:/private/path")

    with serve(tmp_path, Crash()) as c:
        r = say(c)
        streamed = say(c, stream=True)
    assert r.json()["ok"] is False and "secret" not in r.text and "secret" not in streamed.text


def test_message_count_and_length_caps_are_422s(tmp_path):
    with serve(tmp_path, StubPipeline()) as c:
        many = [{"role": "user", "content": "x"}] * 51
        assert c.post("/chat", json={"messages": many}).status_code == 422
        assert say(c, "x" * 8001).status_code == 422
        assert say(c, "x" * 8000).status_code == 200


def test_the_summary_is_folded_after_the_reply(tmp_path, monkeypatch):
    folded = threading.Event()
    calls = []
    monkeypatch.setattr(
        "pandion_api.routes.chat.fold_summary", lambda store, **kw: calls.append(kw) or folded.set()
    )
    with serve(tmp_path, StubPipeline()) as c:
        body = say(c).json()
        assert folded.wait(5)
    assert calls[0]["conversation_id"] == body["conversation_id"] and calls[0]["user_id"] == "anonymous"


def test_memory_off_calls_no_memory_code_and_on_calls_it(tmp_path, monkeypatch):
    remembered = threading.Event()
    monkeypatch.setattr("pandion_api.routes.chat.fold_summary", lambda store, **kw: True)
    monkeypatch.setattr("pandion_api.routes.chat.remember", lambda store, **kw: remembered.set() or [])
    with serve(tmp_path, StubPipeline()) as c:
        say(c)
        assert not remembered.wait(0.5)
    (tmp_path / "on").mkdir()
    with serve(tmp_path / "on", StubPipeline(), memory=True) as c:
        say(c)
        assert remembered.wait(5)
