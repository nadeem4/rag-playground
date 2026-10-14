"""The app has no steps of its own and no manifest of Pandion's.

Pandion loads its own plugins (`pandion.plugins.discover`, which
`pandion.catalog()` and every stage call). That its manifest is complete is
checked in the package's own `test_discovery.py`, and that the engine never
imports the app in its `test_boundaries.py`.
"""

from __future__ import annotations

from pathlib import Path

import pandion
from pandion.plugins import PLUGIN_MODULES

ROOT = Path(__file__).resolve().parents[2]


def test_the_app_has_no_step_of_its_own():
    assert not (ROOT / "playground" / "backend" / "steps").exists()


def test_the_catalog_lists_every_pandion_strategy():
    catalog = pandion.catalog()
    assert sum(len(strategies) for strategies in catalog.values()) == len(PLUGIN_MODULES)
