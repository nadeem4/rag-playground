"""The app retrieves with the pandion package, not with a copy of its own.

The `dense`, `bm25` and `hybrid_rrf` retrievers moved into pandion. These tests
prove the app runs on them: the registry holds the package's classes and the
old module is gone.
"""

from __future__ import annotations

import importlib.util

import pytest

from pandion.ports import Stage
from pandion.registry import registry

RETRIEVERS = ["dense", "bm25", "hybrid_rrf"]


@pytest.mark.parametrize("name", RETRIEVERS)
def test_the_app_registry_holds_the_package_retriever(name):
    assert registry.get(Stage.RETRIEVE, name).__module__ == f"pandion.plugins.retrieve.{name}"


def test_the_app_has_no_retriever_of_its_own():
    modules = {cls.__module__ for cls in registry.all_for(Stage.RETRIEVE).values()}
    assert modules and all(m.startswith("pandion.") for m in modules)


@pytest.mark.parametrize(
    "module", ["plugins.retrieve", "plugins.retrieve._base", "plugins.retrieve.dense"]
)
def test_the_old_module_is_gone(module):
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


