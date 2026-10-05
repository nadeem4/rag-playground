"""On the demo, every step that calls a custom endpoint refuses a private one.

The run routes already refuse custom endpoints on the demo; this checks the
second line: chat, llm_rerank and llm_rewrite all reach `providers.llm.complete`,
which validates the `base_url` before any client is built. The resolver is
mocked to answer 127.0.0.1, as a DNS name pointed at the host would.
"""

from __future__ import annotations

import pytest

from plugins.query.llm_rewrite import LlmRewrite, LlmRewriteConfig
from plugins.rerank.llm_rerank import LlmRerank, LlmRerankConfig
from providers import llm
from providers.endpoints import DEMO_ENDPOINT_ERROR, EndpointRefused
from tests.plugins.test_rerank_llm import QUESTION, payload
from tests.plugins.test_rerank_llm import ctx as rerank_ctx
from tests.plugins.test_use_case_chat import pipeline  # noqa: F401  (fixture)
from tests.plugins.test_use_case_chat_any_model import ask, context, index  # noqa: F401

CUSTOM = {
    "model": "custom",
    "custom_base_url": "https://rebind.example.com/v1",
    "custom_model": "m",
}


@pytest.fixture
def demo(monkeypatch):
    built: list[str | None] = []

    def make(api_key, base_url=None, **options):
        built.append(base_url)
        raise AssertionError("no client may be built for a refused endpoint")

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    monkeypatch.setattr("providers.endpoints._resolve", lambda host: ["127.0.0.1"])
    monkeypatch.setattr(llm, "make_openai_client", make)
    return built


def test_chat_refuses_a_private_endpoint(demo, pipeline, index):  # noqa: F811
    with pytest.raises(EndpointRefused, match="public https address"):
        ask(pipeline, index=index, ctx=context(), **CUSTOM)
    assert demo == []


def test_llm_rerank_refuses_a_private_endpoint(demo, tmp_path):
    with pytest.raises(EndpointRefused) as info:
        LlmRerank().apply(
            {"result": payload(["a", "b"]), "query": {"text": QUESTION}},
            LlmRerankConfig(**CUSTOM),
            rerank_ctx(tmp_path, creds=None),
        )
    assert str(info.value) == DEMO_ENDPOINT_ERROR
    assert demo == []


def test_llm_rewrite_refuses_a_private_endpoint(demo, tmp_path):
    with pytest.raises(EndpointRefused):
        LlmRewrite().apply(
            {}, LlmRewriteConfig(text=QUESTION, **CUSTOM), rerank_ctx(tmp_path, creds=None)
        )
    assert demo == []
