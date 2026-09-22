"""I-18: one key per provider, each with the I-8 rules.

Anthropic keeps its tests in `test_credentials.py`. This file covers the OpenAI
and custom-endpoint keys: resolution order, demo mode, the settings endpoints,
how the keys reach a run, and that none of them leaks.
"""

from __future__ import annotations

import pytest

from api import credentials
from tests.api.conftest import make_client
from tests.api.test_credentials import (
    FAKE_KEY,
    SEEN,
    all_file_bytes,
    events_of,
    keyed_graph,
    keyed_registry,
    raw_stream,
)

OPENAI_KEY = "sk-openai-test-DO-NOT-LEAK-0123456789"
CUSTOM_KEY = "custom-test-DO-NOT-LEAK-0123456789"
ENV_OPENAI = "sk-openai-test-ENV-0123456789"
DOTENV_OPENAI = "sk-openai-test-DOTENV-0123456789"
ALL_HEADERS = {
    "X-Anthropic-Api-Key": FAKE_KEY,
    "X-OpenAI-Api-Key": OPENAI_KEY,
    "X-Custom-Api-Key": CUSTOM_KEY,
}


def write_dotenv(**values: str) -> None:
    text = "".join(f"{k}={v}\n" for k, v in values.items())
    credentials.DOTENV_PATH.write_text(text, encoding="utf-8")


# --- the resolver -------------------------------------------------------------


@pytest.mark.parametrize(
    "provider,env_var",
    [("openai", "OPENAI_API_KEY"), ("custom", "OPENAI_COMPATIBLE_API_KEY")],
)
def test_order_is_header_then_env_then_dotenv(monkeypatch, provider, env_var):
    assert credentials.resolve_key(None, provider) == (None, "none")
    write_dotenv(**{env_var: DOTENV_OPENAI})
    assert credentials.resolve_key(None, provider) == (DOTENV_OPENAI, "dotenv")
    assert credentials.server_source(provider) == "dotenv"
    monkeypatch.setenv(env_var, ENV_OPENAI)
    assert credentials.resolve_key(None, provider) == (ENV_OPENAI, "env")
    assert credentials.server_source(provider) == "env"
    assert credentials.resolve_key(OPENAI_KEY, provider) == (OPENAI_KEY, "header")


def test_providers_do_not_share_keys(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", ENV_OPENAI)
    assert credentials.resolve_key(None, "anthropic") == (None, "none")
    assert credentials.resolve_key(None, "custom") == (None, "none")
    assert credentials.resolve_key(None, "openai") == (ENV_OPENAI, "env")


def test_unknown_provider_is_refused():
    with pytest.raises(KeyError):
        credentials.resolve_key(None, "gemini")


@pytest.mark.parametrize("provider", ["anthropic", "openai", "custom"])
def test_demo_mode_is_header_only_for_every_provider(monkeypatch, provider):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    env_var = credentials.PROVIDERS[provider].env_var
    monkeypatch.setenv(env_var, ENV_OPENAI)
    write_dotenv(**{env_var: DOTENV_OPENAI})
    assert credentials.resolve_key(None, provider) == (None, "none")
    assert credentials.server_source(provider) == "none"
    assert credentials.resolve_key(OPENAI_KEY, provider) == (OPENAI_KEY, "header")


def test_redact_scrubs_several_keys():
    value = {"e": f"{OPENAI_KEY} and {CUSTOM_KEY}", "n": [FAKE_KEY]}
    assert credentials.redact(value, [OPENAI_KEY, CUSTOM_KEY, FAKE_KEY]) == {
        "e": "[redacted] and [redacted]",
        "n": ["[redacted]"],
    }
    assert credentials.redact(value, []) == value


# --- GET /api/settings/llm ----------------------------------------------------


def test_settings_report_one_source_per_provider(client, monkeypatch):
    assert client.get("/api/settings/llm").json() == {
        "anthropic": "none", "openai": "none", "custom": "none",
    }
    write_dotenv(OPENAI_COMPATIBLE_API_KEY=DOTENV_OPENAI)
    monkeypatch.setenv("OPENAI_API_KEY", ENV_OPENAI)
    r = client.get("/api/settings/llm", headers=ALL_HEADERS)
    assert r.json() == {"anthropic": "none", "openai": "env", "custom": "dotenv"}
    for secret in (ENV_OPENAI, DOTENV_OPENAI, OPENAI_KEY, CUSTOM_KEY, FAKE_KEY):
        assert secret not in r.text


def test_demo_settings_report_none_for_every_provider(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    monkeypatch.setenv("OPENAI_API_KEY", ENV_OPENAI)
    write_dotenv(OPENAI_COMPATIBLE_API_KEY=DOTENV_OPENAI)
    assert client.get("/api/settings/llm").json() == {
        "anthropic": "none", "openai": "none", "custom": "none",
    }


# --- POST /api/settings/llm/check ---------------------------------------------


class FakeModels:
    def __init__(self, exc):
        self.exc = exc

    def list(self):
        if self.exc:
            raise self.exc
        return []


def fake_openai(monkeypatch, exc=None) -> list[dict]:
    import openai

    calls: list[dict] = []

    class FakeClient:
        def __init__(self, **kwargs):
            calls.append(kwargs)
            self.models = FakeModels(exc)

    monkeypatch.setattr(openai, "OpenAI", FakeClient)
    return calls


def test_check_openai_with_header(client, monkeypatch):
    calls = fake_openai(monkeypatch)
    r = client.post(
        "/api/settings/llm/check", json={"provider": "openai"}, headers=ALL_HEADERS
    )
    assert r.json() == {"ok": True, "source": "header", "error": None}
    [call] = calls
    assert call["api_key"] == OPENAI_KEY and "base_url" not in call
    assert OPENAI_KEY not in r.text


def test_check_openai_with_no_key_makes_no_call(client, monkeypatch):
    calls = fake_openai(monkeypatch)
    body = client.post("/api/settings/llm/check", json={"provider": "openai"}).json()
    assert body["ok"] is False and body["source"] == "none"
    assert "OPENAI_API_KEY" in body["error"]
    assert calls == []


def test_check_openai_rejected_key_is_readable_and_redacted(client, monkeypatch):
    import httpx2
    import openai

    req = httpx2.Request("GET", "https://api.openai.com/v1/models")
    fake_openai(
        monkeypatch,
        openai.AuthenticationError(
            f"bad {OPENAI_KEY}", response=httpx2.Response(401, request=req), body=None
        ),
    )
    r = client.post(
        "/api/settings/llm/check", json={"provider": "openai"}, headers=ALL_HEADERS
    )
    assert r.json()["ok"] is False and "rejected" in r.json()["error"]
    assert OPENAI_KEY not in r.text


def test_check_openai_other_failure_is_redacted(client, monkeypatch):
    fake_openai(monkeypatch, RuntimeError(f"boom {OPENAI_KEY}"))
    r = client.post(
        "/api/settings/llm/check", json={"provider": "openai"}, headers=ALL_HEADERS
    )
    assert "[redacted]" in r.json()["error"] and OPENAI_KEY not in r.text


def test_check_custom_uses_the_base_url_and_needs_no_key(client, monkeypatch):
    calls = fake_openai(monkeypatch)
    r = client.post(
        "/api/settings/llm/check",
        json={"provider": "custom", "base_url": "http://localhost:11434/v1"},
    )
    assert r.json() == {"ok": True, "source": "none", "error": None}
    [call] = calls
    assert call["base_url"] == "http://localhost:11434/v1"
    assert call["api_key"] == "not-needed"


def test_check_custom_without_a_base_url_makes_no_call(client, monkeypatch):
    calls = fake_openai(monkeypatch)
    body = client.post("/api/settings/llm/check", json={"provider": "custom"}).json()
    assert body["ok"] is False and "base URL" in body["error"]
    assert calls == []


def test_check_custom_is_refused_in_demo_mode(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    calls = fake_openai(monkeypatch)
    r = client.post(
        "/api/settings/llm/check",
        json={"provider": "custom", "base_url": "http://169.254.169.254/latest"},
        headers=ALL_HEADERS,
    )
    assert r.status_code == 403
    assert calls == []


def test_check_unknown_provider_is_a_422(client):
    r = client.post("/api/settings/llm/check", json={"provider": "gemini"})
    assert r.status_code == 422


# --- the keys reach a run, and never leak -------------------------------------


@pytest.fixture
def kclient(dirs):
    with make_client(dirs, keyed_registry()) as c:
        yield c


def test_every_provider_key_reaches_the_transform(kclient):
    r = kclient.post("/api/runs", json={"graph": keyed_graph()}, headers=ALL_HEADERS)
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN and all(
        s["credentials"] == {
            "anthropic_api_key": FAKE_KEY,
            "openai_api_key": OPENAI_KEY,
            "custom_api_key": CUSTOM_KEY,
        }
        for s in SEEN
    )


def test_env_openai_key_reaches_a_sweep(kclient, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", ENV_OPENAI)
    r = kclient.post(
        "/api/sweeps",
        json={"graph": keyed_graph(), "node_id": "x",
              "variants": [{"transform": "p", "config": {"tag": "1"}}]},
    )
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN and all(s["credentials"] == {"openai_api_key": ENV_OPENAI} for s in SEEN)


def test_demo_host_keys_never_reach_a_run(kclient, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    monkeypatch.setenv("OPENAI_API_KEY", ENV_OPENAI)
    monkeypatch.setenv("OPENAI_COMPATIBLE_API_KEY", ENV_OPENAI)
    r = kclient.post("/api/runs", json={"graph": keyed_graph()})
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN and all("credentials" not in s for s in SEEN)


def test_every_key_is_redacted_from_a_failing_run(kclient, tmp_path, monkeypatch):
    def crash(*args, context_extras=None, **kwargs):
        raise RuntimeError(f"crashed with {context_extras['credentials']}")

    monkeypatch.setattr("api.routes.runs.run", crash)
    r = kclient.post("/api/runs", json={"graph": keyed_graph()}, headers=ALL_HEADERS)
    run_id = r.json()["run_id"]
    stream = raw_stream(kclient, run_id)
    err = next(e for e in events_of(stream) if e["event"] == "run_error")
    assert "[redacted]" in err["error"]
    snapshot = kclient.get(f"/api/runs/{run_id}").text
    files = all_file_bytes(tmp_path)
    state = repr(vars(kclient.app.state.runs.get(run_id)))
    for secret in (FAKE_KEY, OPENAI_KEY, CUSTOM_KEY):
        assert secret not in stream and secret not in snapshot and secret not in state
        assert secret.encode() not in files
