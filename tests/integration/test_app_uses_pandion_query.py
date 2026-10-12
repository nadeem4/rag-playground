"""The app turns questions into queries with the pandion package.

The `text` and `llm_rewrite` query steps, the chat model client and the custom
endpoint check moved into pandion. These tests prove the app runs on them: the
app's registry holds the package's query steps, its chat and rerank steps call
the package's client, the old modules are gone, and a graph run the way the API
runs it (the executor, the app's registry and store, `Deps.run_extras`) gives
the same query as `pandion.rewrite` with the same settings. No model is called.
"""

from __future__ import annotations

import importlib.util

import pytest

import pandion
from api.deps import build_deps
from pandion import llm
from pandion.artifacts import ArtifactType
from pandion.executor import NodeStatus, run
from pandion.graph import Graph, Node
from pandion.payloads import Query
from pandion.ports import Stage
from pandion.registry import registry

QUESTION = "Who is my current employer?"
REWRITE = "current employer company present role"
CREDS = {"anthropic_api_key": "sk-ant-test"}


@pytest.mark.parametrize("name", ["text", "llm_rewrite"])
def test_the_app_registry_holds_the_package_query_step(name):
    assert registry.get(Stage.QUERY, name).__module__ == f"pandion.plugins.query.{name}"


def test_the_app_has_no_query_step_of_its_own():
    modules = {cls.__module__ for cls in registry.all_for(Stage.QUERY).values()}
    assert modules and all(m.startswith("pandion.") for m in modules)


def test_the_apps_chat_and_rerank_steps_call_the_package_client():
    from plugins.rerank import llm_rerank
    from plugins.use_case import chat

    assert chat.llm is llm and llm_rerank.llm is llm


@pytest.mark.parametrize(
    "module",
    [
        "plugins.query.text",
        "plugins.query.llm_rewrite",
        "providers.llm",
        "providers.endpoints",
    ],
)
def test_the_old_module_is_gone(module):
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


class FakeComplete:
    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, model, **kwargs):
        self.calls.append(kwargs)
        return llm.Completion(text=REWRITE, usage={}, stop_reason="end_turn")


def app_query(tmp_path, transform: str, config: dict, extras: dict | None = None) -> Query:
    deps = build_deps(artifacts_dir=tmp_path / "artifacts", sources_dir=tmp_path / "sources")
    graph = Graph(nodes=[Node("q", Stage.QUERY, transform, config)], edges=[])
    result = run(
        graph, deps.registry, deps.store, context_extras={**deps.run_extras(), **(extras or {})}
    )
    node = result.nodes["q"]
    assert node.status is NodeStatus.EXECUTED, node.error
    return Query.model_validate(deps.store.load(node.artifact.id, ArtifactType.QUERY))


def test_the_app_run_gives_the_same_text_query_as_pandion_rewrite(tmp_path):
    in_app = app_query(tmp_path, "text", {"text": QUESTION, "gold_answer": "Acme"})
    on_its_own = pandion.rewrite(QUESTION, use="text", gold_answer="Acme").output

    assert in_app == on_its_own


def test_the_app_run_gives_the_same_rewrite_as_pandion_rewrite(tmp_path, monkeypatch):
    fake = FakeComplete()
    monkeypatch.setattr(llm, "complete", fake)
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO", raising=False)
    config = {"text": QUESTION, "style": "keywords"}

    in_app = app_query(tmp_path, "llm_rewrite", config, {"credentials": CREDS})
    on_its_own = pandion.rewrite(QUESTION, use="llm_rewrite", style="keywords", credentials=CREDS)

    assert in_app == on_its_own.output
    assert in_app.text == REWRITE and in_app.original == QUESTION
    # The same prompt and key went to the model both ways.
    assert fake.calls[0] == fake.calls[1]
