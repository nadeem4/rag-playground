"""Discovery is complete.

A plugin module that nobody wired into `plugins.discover()` must fail, not
vanish: otherwise it would also vanish from the contract suite, which
parametrizes over the registry and would report it as covered by saying nothing
about it. That the engine never imports the app is checked in the package's own
`test_boundaries.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pandion.ports import STAGE_OUTPUT
from pandion.registry import registry
from pandion.plugins import PLUGIN_MODULES as PANDION_MODULES
from plugins import PLUGIN_MODULES, discover

ROOT = Path(__file__).resolve().parents[2]


def plugin_module_names() -> list[str]:
    """Every `plugins/<stage>/<name>.py` that is meant to register something.

    `__init__.py` holds package-level helpers and `_`-prefixed modules are
    private shared code, so neither is expected to register a transform.
    """
    out: list[str] = []
    for path in sorted((ROOT / "plugins").glob("*/*.py")):
        if path.name == "__init__.py" or path.name.startswith("_"):
            continue
        out.append(f"plugins.{path.parent.name}.{path.stem}")
    return out


def registered_modules() -> set[str]:
    discover()
    return {
        cls.__module__
        for stage in STAGE_OUTPUT
        for cls in registry.all_for(stage).values()
    }


def test_manifest_lists_every_plugin_module():
    own = [m for m in PLUGIN_MODULES if not m.startswith("pandion.")]
    assert sorted(own) == sorted(plugin_module_names()), (
        "plugins/__init__.py's PLUGIN_MODULES is out of sync with the files on "
        "disk — a plugin that is not discovered is also not contract-tested"
    )


@pytest.mark.parametrize("module", plugin_module_names())
def test_every_plugin_module_registers_a_transform(module):
    assert module in registered_modules(), (
        f"{module} defines no registered transform, or is missing from "
        "plugins.PLUGIN_MODULES"
    )


def test_discover_is_idempotent():
    # The registry raises DuplicateTransformError on re-registration, so a
    # second call that actually re-imported would blow up here.
    before = len(registered_modules())
    discover()
    discover()
    assert len(registered_modules()) == before


def test_the_manifest_loads_every_pandion_strategy():
    """The app loads the package's strategies too, in their old place in the order."""
    assert set(PANDION_MODULES) <= set(PLUGIN_MODULES)
    assert set(PANDION_MODULES) <= registered_modules()
