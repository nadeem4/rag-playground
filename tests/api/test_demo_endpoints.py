"""On the demo, a step that calls a custom endpoint refuses a private one.

The playground's Policy refuses custom endpoints on the demo with a 403. This
checks the second line behind it: pandion-api hands every run
`PlaygroundPolicy.public_endpoints_only`, and Pandion then validates the
endpoint's address before any client is built. The resolver is mocked to
answer 127.0.0.1, as a DNS name pointed at the host would.
"""

from __future__ import annotations

from pandion import llm
from pandion.endpoints import DEMO_ENDPOINT_ERROR

from api import demo as api_demo
from api.policy import PlaygroundPolicy
from tests.api.conftest import read_sse
from tests.api.test_v2_strategies import CUSTOM_CONFIGS


def test_on_the_demo_every_run_asks_for_public_endpoints_only(monkeypatch):
    policy = PlaygroundPolicy()
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert policy.public_endpoints_only(None) is True
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    assert policy.public_endpoints_only(None) is False


def test_the_run_switch_holds_even_if_the_policy_ban_is_lifted(monkeypatch):
    """The 403 reads `api.demo.enabled()`; the second line reads `public_endpoints_only()`."""
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    monkeypatch.setattr(api_demo, "enabled", lambda: False)
    assert PlaygroundPolicy().public_endpoints_only(None) is True


def test_a_demo_question_with_a_private_endpoint_fails_even_without_the_ban(client, monkeypatch):
    built: list = []

    def make(*args, **kwargs):
        built.append(kwargs.get("base_url"))
        raise AssertionError("no client may be built for a refused endpoint")

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    monkeypatch.setattr(api_demo, "enabled", lambda: False)  # lift the 403
    monkeypatch.setattr("pandion.endpoints._resolve", lambda host: ["127.0.0.1"])
    monkeypatch.setattr(llm, "make_openai_client", make)
    sample = client.post("/api/sources/sample").json()
    body = {
        "config": CUSTOM_CONFIGS["llm_rewrite"],
        "documents": [sample["sha"]],
        "question": "What is chunking?",
        "answer": False,
    }
    r = client.post("/api/v2/ask", json=body)
    assert r.status_code == 202, r.text
    events = read_sse(client, r.json()["run_id"])
    errors = [e.get("error", "") for e in events if e["event"] in ("node_failed", "run_error")]
    assert any(DEMO_ENDPOINT_ERROR in e for e in errors), events
    assert built == []
