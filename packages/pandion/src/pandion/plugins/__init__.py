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
The cleaners and the chunkers need nothing beyond the standard library and
Pydantic, so they come with the base install.
"""

from __future__ import annotations

import importlib

#: Every module that registers a transform, in stage order.
PLUGIN_MODULES: tuple[str, ...] = (
    "pandion.plugins.parse.pdfium",
    "pandion.plugins.parse.docling",
    "pandion.plugins.clean.header_footer_strip",
    "pandion.plugins.clean.dedupe_blocks",
    "pandion.plugins.clean.drop_matching",
    "pandion.plugins.chunk.recursive_character",
    "pandion.plugins.chunk.layout_blocks",
    "pandion.plugins.chunk.markdown_header",
    "pandion.plugins.chunk.token_based",
    "pandion.plugins.chunk.sentence_window",
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
