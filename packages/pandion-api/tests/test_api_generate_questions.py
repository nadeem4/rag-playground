"""POST /documents/{sha}/questions/generate: a model writes a question set for a
document, as a run. No test reaches a model: `pandion.llm.complete` is replaced
with a fake, as packages/pandion/tests/test_write_questions.py does.
"""

import json
import threading

from fastapi import HTTPException

from apihelpers import finish, make_client, upload
from pandion import llm
from pandion.llm import Completion
from pandion_api import Policy

KEY = "sk-ant-secret-key-123"
HEADERS = {"X-Anthropic-Api-Key": KEY}
GOOD = json.dumps({
    "question": "Which city is the seat of government in France?",
    "gold_passage": "The capital of France is Paris.",
    "answer": "Paris",
})


class FakeModel:
    """Answers every call with `reply`, or raises it when it is an exception."""

    def __init__(self, reply=GOOD, before=None):
        self.reply = reply
        self.before = before
        self.calls = 0

    def __call__(self, model, **kwargs):
        self.calls += 1
        if self.before is not None:
            self.before(self.calls)
        if isinstance(self.reply, Exception):
            raise self.reply
        return Completion(text=self.reply, usage={"input_tokens": 10, "output_tokens": 5}, stop_reason="stop", model="m")


def generate(client, sha, headers=HEADERS, **body):
    return client.post(
        f"/documents/{sha}/questions/generate",
        json={"model": "claude-haiku-4-5", **body},
        headers=headers,
    )


def test_the_run_returns_the_set_with_progress_for_each_part(client, monkeypatch):
    model = FakeModel()
    monkeypatch.setattr(llm, "complete", model)
    sha = upload(client)["sha"]
    state, events = finish(client, generate(client, sha, count=3))
    assert state["status"] == "finished" and state["ok"] is True and state["kind"] == "questions"
    result = state["result"]
    assert result["questions"][0]["gold_answers"] == ["The capital of France is Paris."]
    assert result["parts"] == model.calls == 3
    parts = [e for e in events if e["event"] == "part_finished"]
    assert [(e["number"], e["total"]) for e in parts] == [(n, result["parts"]) for n in range(1, result["parts"] + 1)]


def test_the_set_is_not_kept(client, monkeypatch):
    monkeypatch.setattr(llm, "complete", FakeModel())
    sha = upload(client)["sha"]
    finish(client, generate(client, sha, count=1))
    assert client.get(f"/documents/{sha}/questions").json() is None


def test_count_below_one_is_422(client):
    sha = upload(client)["sha"]
    r = generate(client, sha, count=0)
    assert r.status_code == 422 and isinstance(r.json()["detail"], str)


def test_count_above_the_route_cap_is_refused(client):
    sha = upload(client)["sha"]
    r = generate(client, sha, count=51)
    assert r.status_code == 422 and "50" in r.json()["detail"]


def test_the_policy_sees_the_count_as_generation(tmp_path, monkeypatch):
    monkeypatch.setattr(llm, "complete", FakeModel())
    seen = []

    class Counting(Policy):
        def check_question_count(self, kind, count, request):
            seen.append((kind, count))
            if count > 2:
                raise HTTPException(status_code=400, detail="At most 2.")

    with make_client(tmp_path, Counting()) as c:
        sha = upload(c)["sha"]
        assert generate(c, sha, count=3).status_code == 400
        assert generate(c, sha, count=2).status_code == 202
    assert seen == [("generation", 3), ("generation", 2)]


def test_an_unknown_model_is_422(client):
    sha = upload(client)["sha"]
    r = generate(client, sha, model="no-such-model")
    assert r.status_code == 422 and "no-such-model" in r.json()["detail"]


def test_a_missing_key_is_a_plain_400_before_any_run(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    model = FakeModel()
    monkeypatch.setattr(llm, "complete", model)
    sha = upload(client)["sha"]
    r = generate(client, sha, headers={})
    assert r.status_code == 400 and r.json()["detail"] == Policy().missing_key("anthropic")
    assert model.calls == 0 and client.app.state.runs.active() == []


def test_the_policy_can_refuse_the_provider(tmp_path):
    class NoOpenAI(Policy):
        def check_provider(self, provider, request):
            if provider == "openai":
                raise HTTPException(status_code=403, detail="No OpenAI here.")

    with make_client(tmp_path, NoOpenAI()) as c:
        sha = upload(c)["sha"]
        r = generate(c, sha, model="gpt-5.6-luna", headers={"X-OpenAI-Api-Key": "sk-x"})
        assert r.status_code == 403 and r.json()["detail"] == "No OpenAI here."


def test_custom_is_refused_where_only_public_endpoints_are_allowed(tmp_path, monkeypatch):
    model = FakeModel()
    monkeypatch.setattr(llm, "complete", model)

    class PublicOnly(Policy):
        def public_endpoints_only(self, request):
            return True

    with make_client(tmp_path, PublicOnly()) as c:
        sha = upload(c)["sha"]
        r = generate(c, sha, model="custom", model_name="m", base_url="http://127.0.0.1:8000/v1", headers={})
        assert r.status_code == 403 and r.json()["detail"]
    assert model.calls == 0


def test_custom_needs_no_key_where_any_endpoint_is_allowed(client, monkeypatch):
    monkeypatch.setattr(llm, "complete", FakeModel())
    sha = upload(client)["sha"]
    r = generate(client, sha, model="custom", model_name="m", base_url="http://127.0.0.1:8000/v1", headers={}, count=1)
    state, _ = finish(client, r)
    assert state["status"] == "finished"


def test_an_unknown_or_unreadable_document_is_404(tmp_path):
    class Hidden(Policy):
        def can_read(self, sha, request):
            return False

    with make_client(tmp_path) as c:
        assert generate(c, "0" * 64).status_code == 404
    with make_client(tmp_path, Hidden()) as c:
        sha = upload(c)["sha"]
        assert generate(c, sha).status_code == 404


def test_no_key_in_any_message_or_event_when_the_model_error_holds_it(client, monkeypatch):
    monkeypatch.setattr(llm, "complete", FakeModel(RuntimeError(f"401 bad key {KEY} for you")))
    sha = upload(client)["sha"]
    state, events = finish(client, generate(client, sha))
    assert state["status"] == "finished" and state["ok"] is False
    assert "bad key" in state["result"]["error"]
    assert KEY not in json.dumps(state) and KEY not in json.dumps(events)


def test_the_error_goes_through_the_policy_scrub(tmp_path, monkeypatch):
    monkeypatch.setattr(llm, "complete", FakeModel(RuntimeError("failed at /srv/secret/path")))

    class Scrubbing(Policy):
        def scrub(self, text):
            return text.replace("/srv/secret/path", "[server]")

    with make_client(tmp_path, Scrubbing()) as c:
        sha = upload(c)["sha"]
        state, _ = finish(c, generate(c, sha))
    assert state["result"]["error"].endswith("failed at [server]")


def test_cancelling_the_run_stops_further_model_calls(client, monkeypatch):
    go = threading.Event()
    model = FakeModel(before=lambda n: go.wait(10))
    monkeypatch.setattr(llm, "complete", model)
    sha = upload(client)["sha"]
    r = generate(client, sha, count=3)
    run_id = r.json()["run_id"]
    assert client.post(f"/runs/{run_id}/cancel").status_code == 202
    go.set()
    state, _ = finish(client, r)
    assert state["status"] == "cancelled"
    assert model.calls == 1


def test_a_document_that_is_not_a_pdf_ends_the_run_with_a_plain_error(client, monkeypatch):
    model = FakeModel()
    monkeypatch.setattr(llm, "complete", model)
    sha = client.post("/documents", files={"file": ("a.txt", b"hello there", "text/plain")}).json()["sha"]
    state, _ = finish(client, generate(client, sha))
    assert state["ok"] is False and state["result"]["error"] == "this source is not a PDF, so its text cannot be checked"
    assert model.calls == 0
