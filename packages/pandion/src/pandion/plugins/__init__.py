"""The package's own strategies, and their discovery.

**Explicit, not a directory walk.** `PLUGIN_MODULES` is the manifest: a module
that is not on it is not loaded, and `tests/test_discovery.py` fails if the
list and the files disagree, so a forgotten plugin breaks the build instead of
silently not existing.

`discover()` is idempotent because the registry is not: registering a name
twice raises `DuplicateTransformError`.

Importing a plugin module loads no heavy library. Each one imports its
library (pypdfium2, Docling) inside the function that uses it, through
`pandion.errors.require`, so the base install can discover every strategy.
"""

from __future__ import annotations

import importlib

#: Every module that registers a transform, in stage order.
PLUGIN_MODULES: tuple[str, ...] = (
    "pandion.plugins.parse.pdfium",
    "pandion.plugins.parse.docling",
)

_discovered = False


def discover() -> tuple[str, ...]:
    """Import every plugin module. Safe to call repeatedly."""
    global _discovered
    if not _discovered:
        for module in PLUGIN_MODULES:
            importlib.import_module(module)
        _discovered = True
    return PLUGIN_MODULES
