"""The app answers with the pandion package, not with a copy of its own.

The `search` and `chat` steps moved into pandion as the answer step. These
tests prove the app runs on them: the registry holds the package's classes
under the use_case stage, the old modules are gone, and the app has no steps
of its own. That a run gives the package's answer is pandion-api's and
Pandion's own tests.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from pandion.ports import Stage
from pandion.registry import registry

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("name", ["search", "chat"])
def test_the_app_registry_holds_the_package_answer_step(name):
    assert registry.get(Stage.USE_CASE, name).__module__ == f"pandion.plugins.answer.{name}"


@pytest.mark.parametrize(
    "module", ["plugins.use_case.search", "plugins.use_case.chat", "plugins.use_case._grounding"]
)
def test_the_old_module_is_gone(module):
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


def test_the_root_plugins_folder_is_gone():
    assert not (ROOT / "plugins").exists()
    assert importlib.util.find_spec("plugins") is None


def test_the_app_has_no_steps_of_its_own():
    assert not (ROOT / "playground" / "backend" / "steps").exists()
    assert registry.get(Stage.USE_CASE, "eval").__module__ == "pandion.plugins.answer.eval"
