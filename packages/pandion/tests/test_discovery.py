"""The package registers its own strategies, and registering them stays light.

`PLUGIN_MODULES` is the manifest: a plugin file that is not on it is not
loaded, and this test fails rather than letting it vanish. Importing pandion
and calling `discover()` must not load torch, Docling, LanceDB, a model
library or a chat SDK: those come with extras, and only the step that needs one
imports it.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from pandion.ports import STAGE_OUTPUT
from pandion.registry import registry
from pandion.routing import CHECKS
from pandion.plugins import PLUGIN_MODULES, discover

PLUGINS = Path(__file__).resolve().parents[1] / "src" / "pandion" / "plugins"

HEAVY = {
    "torch", "docling", "docling_core", "docling_ibm_models", "transformers",
    "sentence_transformers", "lancedb", "pyarrow", "pypdfium2", "numpy",
    "openai", "anthropic", "tantivy", "fsspec",
}


def plugin_files() -> list[str]:
    return sorted(
        f"pandion.plugins.{path.parent.name}.{path.stem}"
        for path in PLUGINS.glob("*/*.py")
        if path.name != "__init__.py" and not path.name.startswith("_")
    )


def test_the_manifest_lists_every_plugin_file():
    assert sorted(PLUGIN_MODULES) == plugin_files()


def test_every_listed_module_registers_a_transform():
    assert discover() == PLUGIN_MODULES
    registered = {
        cls.__module__ for stage in STAGE_OUTPUT for cls in registry.all_for(stage).values()
    } | {check.fn.__module__ for check in CHECKS.values()}
    assert set(PLUGIN_MODULES) <= registered


def test_discover_is_idempotent():
    discover()
    discover()


def test_discovery_imports_no_heavy_library():
    """A subprocess, so nothing an earlier test imported can hide a leak."""
    code = (
        "import sys\n"
        "import pandion, pandion.plugins\n"
        "import pandion.embeddings, pandion.embedding_cache, pandion.models\n"
        "import pandion.config, pandion.pipeline, pandion.sources\n"
        "import pandion.llm, pandion.endpoints\n"
        "pandion.plugins.discover()\n"
        f"heavy = {sorted(HEAVY)!r}\n"
        "leaked = sorted(m for m in sys.modules if m.split('.')[0] in heavy)\n"
        "print(leaked)\n"
        "sys.exit(1 if leaked else 0)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
