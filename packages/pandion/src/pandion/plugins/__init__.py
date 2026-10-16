"""The package's own strategies, and their discovery.

**Explicit, not a directory walk.** `PLUGIN_MODULES` is the manifest: a module
that is not on it is not loaded, and `tests/test_discovery.py` fails if the
list and the files disagree, so a forgotten plugin breaks the build instead of
silently not existing.

`discover()` is idempotent because the registry is not: registering a name
twice raises `DuplicateTransformError`.

Importing a plugin module loads no heavy library. Each one imports its
library (pypdfium2, Docling, LanceDB, numpy, sentence-transformers, the
OpenAI and Anthropic SDKs) inside
the function that uses it, through `pandion.errors.require`, so the base
install can discover every strategy.
The cleaners and the chunkers need nothing beyond the standard library and
Pydantic, so they come with the base install.
"""

from __future__ import annotations

import importlib
import warnings
from importlib import metadata

#: Installed packages add strategies under this entry point group, for example
#: [project.entry-points."pandion.strategies"] qdrant = "pandion_qdrant".
ENTRY_POINT_GROUP = "pandion.strategies"

#: Every module that registers a transform, in stage order.
PLUGIN_MODULES: tuple[str, ...] = (
    "pandion.plugins.source.upload",
    "pandion.plugins.query.text",
    "pandion.plugins.query.llm_rewrite",
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
    "pandion.plugins.enrich.llm_context",
    "pandion.plugins.index.lancedb_store",
    "pandion.plugins.retrieve.dense",
    "pandion.plugins.retrieve.bm25",
    "pandion.plugins.retrieve.hybrid_rrf",
    "pandion.plugins.rerank.mmr",
    "pandion.plugins.rerank.cross_encoder",
    "pandion.plugins.rerank.llm_rerank",
    "pandion.plugins.answer.search",
    "pandion.plugins.answer.chat",
    "pandion.plugins.answer.eval",
)

_discovered = False


def _entry_points():
    return list(metadata.entry_points(group=ENTRY_POINT_GROUP))


def _load_entry_point(ep):
    return ep.load()


def discover() -> tuple[str, ...]:
    """Import every plugin module and installed strategy package. Safe to call repeatedly."""
    global _discovered
    if not _discovered:
        for module in PLUGIN_MODULES:
            importlib.import_module(module)
        for ep in _entry_points():
            try:
                _load_entry_point(ep)
            except Exception as exc:  # a broken third-party package must not break Pandion
                warnings.warn(
                    f"The strategy package '{ep.name}' ({ep.value}) could not be loaded, "
                    f"so its strategies are not available: {exc}",
                    stacklevel=2,
                )
        _discovered = True
    return PLUGIN_MODULES
