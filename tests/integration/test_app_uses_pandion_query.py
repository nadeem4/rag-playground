"""The app turns questions into queries with the pandion package.

The `text` and `llm_rewrite` query steps, the chat model client and the custom
endpoint check moved into pandion. These tests prove the app runs on them: the
registry holds the package's query steps, its chat and rerank steps call the
package's client, and the old modules are gone.
"""

from __future__ import annotations

import importlib.util

import pytest

from pandion import llm
from pandion.ports import Stage
from pandion.registry import registry

@pytest.mark.parametrize("name", ["text", "llm_rewrite"])
def test_the_app_registry_holds_the_package_query_step(name):
    assert registry.get(Stage.QUERY, name).__module__ == f"pandion.plugins.query.{name}"


def test_the_app_has_no_query_step_of_its_own():
    modules = {cls.__module__ for cls in registry.all_for(Stage.QUERY).values()}
    assert modules and all(m.startswith("pandion.") for m in modules)


def test_the_apps_chat_and_rerank_steps_call_the_package_client():
    from pandion.plugins.rerank import llm_rerank
    from pandion.plugins.answer import chat

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
