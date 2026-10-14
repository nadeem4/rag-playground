"""Which model keys the server has, and whether a key works."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from apihelpers import make_client
from pandion_api import Policy
from pandion_api.credentials import PROVIDERS


@pytest.fixture(autouse=True)
def no_server_keys(monkeypatch):
    for spec in PROVIDERS.values():
        monkeypatch.delenv(spec.env_var, raising=False)


def fake_openai(monkeypatch, exc: Exception | None = None) -> list[dict]:
    import openai

    calls: list[dict] = []

    class FakeClient:
        def __init__(self, **kwargs):
            calls.append(kwargs)

            def listing():
                if exc:
                    raise exc
                return []

            self.models = SimpleNamespace(list=listing)

    monkeypatch.setattr(openai, "OpenAI", FakeClient)
    return calls


def test_the_server_says_where_each_of_its_keys_comes_from_and_never_the_key(client, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-server")
    r = client.get("/settings/models")
    assert r.json() == {"anthropic": "none", "openai": "env", "custom": "none", "openrouter": "none"}
    assert "sk-server" not in r.text


def test_a_working_key_is_checked_with_one_free_call(client, monkeypatch):
    calls = fake_openai(monkeypatch)
    r = client.post("/settings/models/check", json={"provider": "openai"}, headers={"X-OpenAI-Api-Key": "sk-test"})
    assert r.json() == {"ok": True, "source": "header", "error": None}
    assert calls[0]["api_key"] == "sk-test" and calls[0]["max_retries"] == 0


def test_without_a_key_nothing_is_called_and_the_sentence_says_where_one_goes(client, monkeypatch):
    calls = fake_openai(monkeypatch)
    body = client.post("/settings/models/check", json={"provider": "openai"}).json()
    assert body == {"ok": False, "source": "none", "error": Policy().missing_key("openai")}
    assert "X-OpenAI-Api-Key" in body["error"] and "OPENAI_API_KEY" in body["error"]
    assert calls == []


def test_a_failure_shows_its_message_without_the_key(client, monkeypatch):
    fake_openai(monkeypatch, RuntimeError("the server said no to sk-test"))
    body = client.post("/settings/models/check", json={"provider": "openai"}, headers={"X-OpenAI-Api-Key": "sk-test"}).json()
    assert body["ok"] is False and body["error"] == "RuntimeError: the server said no to [redacted]"


def test_a_custom_endpoint_needs_its_base_url(client, monkeypatch):
    calls = fake_openai(monkeypatch)
    body = client.post("/settings/models/check", json={"provider": "custom"}).json()
    assert body["ok"] is False and "base URL" in body["error"] and calls == []


def test_the_policy_can_refuse_a_provider_and_require_public_addresses(tmp_path, monkeypatch):
    calls = fake_openai(monkeypatch)

    class Careful(Policy):
        def check_provider(self, provider, request):
            if provider == "openrouter":
                raise HTTPException(403, "Not here.")

        def public_endpoints_only(self, request):
            return True

    with make_client(tmp_path, Careful()) as c:
        assert c.post("/settings/models/check", json={"provider": "openrouter"}).status_code == 403
        body = c.post("/settings/models/check", json={"provider": "custom", "base_url": "http://127.0.0.1:9/v1"}).json()
    assert body["ok"] is False and calls == []


def test_an_unknown_provider_is_422(client):
    assert client.post("/settings/models/check", json={"provider": "gemini"}).status_code == 422


def test_the_package_declares_the_sdks_the_key_check_imports():
    """keycheck.py imports anthropic and openai, so installing pandion-api installs them."""
    import tomllib
    from pathlib import Path

    project = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    pandion = next(d for d in project["project"]["dependencies"] if d.startswith("pandion["))
    extras = set(pandion[len("pandion[") : pandion.index("]")].split(","))
    assert {"anthropic", "openai"} <= extras
