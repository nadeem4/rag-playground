"""On the demo, every step that calls a custom endpoint refuses a private one.

The run routes already refuse custom endpoints on the demo; this checks the
second line: chat, llm_rerank and llm_rewrite all reach `pandion.llm.complete`,
which validates the `base_url` before any client is built. The resolver is
mocked to answer 127.0.0.1, as a DNS name pointed at the host would.

pandion never reads the demo switch. The package's chat, llm_rewrite and
llm_rerank get it from the run, as `context_extras["public_endpoints_only"]`,
which the app sets in `Deps.run_extras()` from `plugins.hosted_demo`.
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
from pandion.plugins.rerank.llm_rerank import LlmRerank, LlmRerankConfig
from tests.plugins.rerank_fakes import QUESTION, payload
from tests.plugins.rerank_fakes import ctx as rerank_ctx
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


def test_chat_refuses_a_private_endpoint_with_the_apps_run_extras(
    demo, pipeline, index, tmp_path  # noqa: F811
):
    run_ctx = context()
    run_ctx.extras.update(build_deps(artifacts_dir=tmp_path / "a").run_extras())
    with pytest.raises(EndpointRefused) as info:
        ask(pipeline, index=index, ctx=run_ctx, **CUSTOM)
    assert str(info.value) == DEMO_ENDPOINT_ERROR
    assert demo == []


def test_chat_without_the_extra_reaches_the_client(demo, pipeline, index):  # noqa: F811
    """pandion never reads the demo switch itself: the run must pass it."""
    with pytest.raises(AssertionError, match="no client may be built"):
        ask(pipeline, index=index, ctx=context(), **CUSTOM)
    assert demo == ["https://rebind.example.com/v1"]


def test_llm_rerank_refuses_a_private_endpoint_with_the_apps_run_extras(demo, tmp_path):
    run_ctx = rerank_ctx(tmp_path, creds=None)
    run_ctx.extras.update(build_deps(artifacts_dir=tmp_path / "a").run_extras())
    with pytest.raises(EndpointRefused) as info:
        LlmRerank().apply(
            {"result": payload(["a", "b"]), "query": {"text": QUESTION}},
            LlmRerankConfig(**CUSTOM),
            run_ctx,
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


def test_a_demo_run_of_llm_rerank_fails_on_a_private_endpoint(demo, tmp_path):
    """The whole app path for the reranker: index a PDF with the fake embedder,
    retrieve, then llm_rerank, run with `Deps.run_extras()` (behind the 403)."""
    from pandion.graph import Edge
    from tests.plugins.conftest import SAMPLE_PAGES, build_pdf

    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    deps = build_deps(artifacts_dir=tmp_path / "a", sources_dir=tmp_path / "s")
    stored = deps.run_extras()["sources"].add(pdf)
    graph = Graph(
        nodes=[
            Node("src", Stage.SOURCE, "upload", {"sha": stored.sha, "filename": stored.filename}),
            Node("q", Stage.QUERY, "text", {"text": QUESTION}),
            Node("parse", Stage.PARSE, "pdfium", {}),
            Node("chunk", Stage.CHUNK, "recursive_character", {}),
            Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
            Node("dense", Stage.RETRIEVE, "dense", {}),
            Node("rr", Stage.RERANK, "llm_rerank", CUSTOM),
        ],
        edges=[
            Edge("src", "parse", "file"),
            Edge("parse", "chunk", "doc"),
            Edge("chunk", "index", "chunks"),
            Edge("index", "dense", "index"),
            Edge("dense", "rr", "result"),
        ],
    )
    result = run(graph, deps.registry, deps.store, context_extras=deps.run_extras())
    assert result.nodes["dense"].status is NodeStatus.EXECUTED
    assert result.nodes["rr"].status is NodeStatus.FAILED
    assert DEMO_ENDPOINT_ERROR in (result.nodes["rr"].error or "")
    assert demo == []


def test_a_demo_run_of_chat_fails_on_a_private_endpoint(demo, tmp_path):
    """The whole app path for the package's chat step: index a PDF with the
    fake embedder, retrieve, then chat, run with `Deps.run_extras()`."""
    from pandion.graph import Edge
    from tests.plugins.conftest import SAMPLE_PAGES, build_pdf

    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    deps = build_deps(artifacts_dir=tmp_path / "a", sources_dir=tmp_path / "s")
    stored = deps.run_extras()["sources"].add(pdf)
    graph = Graph(
        nodes=[
            Node("src", Stage.SOURCE, "upload", {"sha": stored.sha, "filename": stored.filename}),
            Node("q", Stage.QUERY, "text", {"text": QUESTION}),
            Node("parse", Stage.PARSE, "pdfium", {}),
            Node("chunk", Stage.CHUNK, "recursive_character", {}),
            Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
            Node("dense", Stage.RETRIEVE, "dense", {}),
            Node("chat", Stage.USE_CASE, "chat", CUSTOM),
        ],
        edges=[
            Edge("src", "parse", "file"),
            Edge("parse", "chunk", "doc"),
            Edge("chunk", "index", "chunks"),
            Edge("index", "dense", "index"),
            Edge("dense", "chat", "result"),
        ],
    )
    result = run(graph, deps.registry, deps.store, context_extras=deps.run_extras())
    assert result.nodes["dense"].status is NodeStatus.EXECUTED
    assert result.nodes["chat"].status is NodeStatus.FAILED
    assert DEMO_ENDPOINT_ERROR in (result.nodes["chat"].error or "")
    assert demo == []
