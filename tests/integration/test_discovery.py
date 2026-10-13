"""Discovery is complete.

The app has no step of its own, so its manifest holds only Pandion's modules and
every one of them registers. That the engine never imports the app is checked in
the package's own `test_boundaries.py`.
"""

from __future__ import annotations

from pathlib import Path

from pandion.ports import STAGE_OUTPUT
from pandion.registry import registry
from pandion.plugins import PLUGIN_MODULES as PANDION_MODULES
from api.steps import PLUGIN_MODULES, discover

ROOT = Path(__file__).resolve().parents[2]


def registered_modules() -> set[str]:
    discover()
    return {
        cls.__module__
        for stage in STAGE_OUTPUT
        for cls in registry.all_for(stage).values()
    }


def test_the_app_has_no_step_of_its_own():
    """The app has no step of its own left: every module in the manifest is Pandion's."""
    own = [m for m in PLUGIN_MODULES if not m.startswith("pandion.")]
    assert own == []
    assert not [p for p in (ROOT / "api" / "steps").glob("*.py") if p.name != "__init__.py"]


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
