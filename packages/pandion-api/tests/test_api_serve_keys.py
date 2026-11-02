"""Serve takes model keys from the environment only, and calls public endpoints only."""

import pytest
import yaml

from apihelpers import PIPELINE, make_serve_client, settings
from pandion_api import Policy, create_app
from test_api_chat import StubPipeline, say, serve


class HeaderKeys(Policy):
    def user_id(self, request):
        return "ann"

    def roles(self, request):
        return None

    def limit(self, request):
        return None

    def key(self, provider, request):
        return ("from-override", "header")

    def credentials(self, request):
        return {"anthropic_api_key": "from-override"}


def test_serve_ignores_key_headers(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    stub = StubPipeline()
    with serve(tmp_path, stub) as c:
        c.post(
            "/chat", json={"messages": [{"role": "user", "content": "Q?"}]}, headers={"X-Anthropic-Api-Key": "from-header"}
        )
    assert not stub.asked[0]["credentials"]


def test_the_env_key_is_used(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
    stub = StubPipeline()
    with serve(tmp_path, stub) as c:
        say(c)
    assert stub.asked[0]["credentials"] == {"anthropic_api_key": "from-env"}


def test_a_policy_cannot_return_header_keys_in_serve(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    stub = StubPipeline()
    with serve(tmp_path, stub, HeaderKeys()) as c:
        say(c)
    assert not stub.asked[0]["credentials"]


def test_public_endpoints_only_is_on(tmp_path):
    with make_serve_client(tmp_path) as c:
        assert c.app.state.pipeline.config.models.public_endpoints_only is True


def test_a_private_custom_endpoint_stops_startup(tmp_path):
    answer = {"use": "chat", "custom_base_url": "http://127.0.0.1:11434/v1", "custom_model": "llama"}
    file = tmp_path / "pipeline.yaml"
    file.write_text(yaml.safe_dump({**PIPELINE, "answer": answer}), encoding="utf-8")
    with pytest.raises(ValueError, match="public"):
        create_app(settings(tmp_path), Policy.anonymous(), mode="serve", pipeline=file)
