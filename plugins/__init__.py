"""Plugin discovery: import every plugin module so `@register` fires.

**Explicit, not `pkgutil`.** The list below is the manifest, and a module that is
not on it is not loaded. That reads as a maintenance burden until you notice what
the alternative costs: a directory walk silently absorbs a module that fails to
import, or quietly picks up a scratch file, and either way the registry's
contents become a function of what happens to be on disk. Here the manifest is
data a test can compare against the filesystem, so a plugin someone forgot to
wire up fails the build (`tests/integration/test_discovery.py`) instead of simply
not existing.

`discover()` is idempotent because the registry is not: re-registering raises
`DuplicateTransformError`, and `discover()` is called from the root conftest, the
API server, and any script that wants a populated registry — all of which may
run in the same process.
"""

from __future__ import annotations

import importlib

#: Every module that registers a transform, in stage order. Keep in sync with
#: `plugins/*/*.py`; the discovery test enforces it.
PLUGIN_MODULES: tuple[str, ...] = (
    "plugins.source.upload",
    "plugins.query.text",
    "plugins.parse.pdfium",
    "plugins.parse.docling",
    "plugins.clean.header_footer_strip",
    "plugins.clean.dedupe_blocks",
    "plugins.chunk.recursive_character",
    "plugins.chunk.markdown_header",
    "plugins.chunk.token_based",
    "plugins.index.lancedb_store",
    "plugins.retrieve.dense",
    "plugins.retrieve.bm25",
    "plugins.retrieve.hybrid_rrf",
    "plugins.rerank.mmr",
    "plugins.use_case.search",
)

_discovered = False


def discover() -> tuple[str, ...]:
    """Import every plugin module. Safe to call repeatedly.

    Returns the manifest, so a caller can assert over what was loaded.
    """
    global _discovered
    if not _discovered:
        for module in PLUGIN_MODULES:
            importlib.import_module(module)
        _discovered = True
    return PLUGIN_MODULES
