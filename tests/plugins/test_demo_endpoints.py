"""On the demo, every step that calls a custom endpoint refuses a private one.

The run routes already refuse custom endpoints on the demo; this checks the
second line: chat, llm_rerank and llm_rewrite all reach `pandion.llm.complete`,
which validates the `base_url` before any client is built. The resolver is
mocked to answer 127.0.0.1, as a DNS name pointed at the host would.

pandion never reads the demo switch. The app's own steps (chat, llm_rerank)
read it from `plugins.hosted_demo`, and the package's llm_rewrite gets it from
the run, as `context_extras["public_endpoints_only"]`, which the app sets in
`Deps.run_extras()`.
"""

from __future__ import annotations

import pytest

from api import demo as api_demo
from api.deps import build_deps
from pandion import llm
from pandion.endpoints import DEMO_ENDPOINT_ERROR, EndpointRefused
from pandion.executor import NodeStatus, run
from pandion.graph import Graph, Node
from pandion.plugins.query.llm_rewrite import LlmRewrite, LlmRewriteConfig
from pandion.ports import Stage
from plugins import hosted_demo
from plugins.rerank.llm_rerank import LlmRerank, LlmRerankConfig
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
    monkeypatch.setattr("pandion.endpoints._resolve", lambda host: ["127.0.0.1"])
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


def test_llm_rewrite_refuses_a_private_endpoint_with_the_apps_run_extras(demo, tmp_path):
    run_ctx = rerank_ctx(tmp_path, creds=None)
    run_ctx.extras.update(build_deps(artifacts_dir=tmp_path / "a").run_extras())
    with pytest.raises(EndpointRefused):
        LlmRewrite().apply({}, LlmRewriteConfig(text=QUESTION, **CUSTOM), run_ctx)
    assert demo == []


def test_on_the_demo_every_run_asks_for_public_endpoints_only(monkeypatch, tmp_path):
    deps = build_deps(artifacts_dir=tmp_path / "a", sources_dir=tmp_path / "s")
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert deps.run_extras()["public_endpoints_only"] is True
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    assert deps.run_extras()["public_endpoints_only"] is False


def test_the_run_extra_holds_even_if_the_route_ban_is_lifted(monkeypatch, tmp_path):
    """The 403 reads `api.demo`; the second line reads its own switch."""
    deps = build_deps(artifacts_dir=tmp_path / "a", sources_dir=tmp_path / "s")
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    monkeypatch.setattr(api_demo, "enabled", lambda: False)
    assert deps.run_extras()["public_endpoints_only"] is True


def test_a_demo_run_of_llm_rewrite_fails_on_a_private_endpoint(demo, tmp_path):
    """The whole app path: the executor, the app's registry and store, and
    `Deps.run_extras()`, as the run routes call it (behind their 403)."""
    deps = build_deps(artifacts_dir=tmp_path / "a", sources_dir=tmp_path / "s")
    graph = Graph(
        nodes=[Node("q", Stage.QUERY, "llm_rewrite", {"text": QUESTION, **CUSTOM})],
        edges=[],
    )
    result = run(graph, deps.registry, deps.store, context_extras=deps.run_extras())
    assert result.nodes["q"].status is NodeStatus.FAILED
    assert DEMO_ENDPOINT_ERROR in (result.nodes["q"].error or "")
    assert demo == []


def test_the_demo_switch_is_the_same_one_the_api_reads():
    assert hosted_demo.ENV_VAR == api_demo.ENV_VAR
