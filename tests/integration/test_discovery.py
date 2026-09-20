"""Discovery is complete, and the dependency arrow points one way.

Two build-breaking guarantees live here. A plugin module that nobody wired into
`plugins.discover()` must fail, not vanish — otherwise it would also vanish from
the contract suite, which parametrizes over the registry and would report it as
covered by saying nothing about it. And `core/` must not import `plugins/`: that
is the phase exit criterion, and it is the difference between an engine with
plugins and a pile of mutually aware modules.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from core.ports import STAGE_OUTPUT
from core.registry import registry
from plugins import PLUGIN_MODULES, discover

ROOT = Path(__file__).resolve().parents[2]


def plugin_module_names() -> list[str]:
    """Every `plugins/<stage>/<name>.py` that is meant to register something.

    `__init__.py` holds package-level helpers and `_`-prefixed modules are
    private shared code (`plugins/retrieve/_base.py`), so neither is expected to
    register a transform.
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
    assert sorted(PLUGIN_MODULES) == sorted(plugin_module_names()), (
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


def test_core_imports_nothing_from_plugins():
    """The arrow points `plugins -> core`, and never back."""
    offenders: list[str] = []
    for path in sorted((ROOT / "core").rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                if name == "plugins" or name.startswith("plugins."):
                    offenders.append(f"{path.relative_to(ROOT)}:{node.lineno} {name}")

    assert not offenders, "core/ must not import plugins/: " + ", ".join(offenders)
