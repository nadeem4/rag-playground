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
import sys
import warnings
from collections.abc import Iterable
from importlib import metadata
from pathlib import Path

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
    "pandion.plugins.route.checks",
)

_discovered = False

#: Each entry point that failed to load: (name, value, error). `discover()` only
#: warns about it; `load()` stops on the first.
_failed: list[tuple[str, str, BaseException]] = []


class PluginError(ValueError):
    """A plugin module or installed strategy package could not be loaded."""

    def __init__(self, module: str, cause: BaseException):
        self.module = module
        self.cause = cause
        super().__init__(
            f"The plugin '{module}' could not be loaded: {type(cause).__name__}: {cause}. "
            "Fix or remove that installed plugin, then start again."
        )


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
                _failed.append((ep.name, ep.value, exc))
                warnings.warn(
                    f"The strategy package '{ep.name}' ({ep.value}) could not be loaded, "
                    f"so its strategies are not available: {exc}",
                    stacklevel=2,
                )
        _discovered = True
    return PLUGIN_MODULES


def load(project_dir: str | Path, modules: Iterable[str] = ()) -> list[str]:
    """The one plugin loader: built-ins, then installed packages, then `modules`.

    `project_dir` is on sys.path only while the modules import. Any failure
    raises `PluginError`; nothing is skipped. Returns the modules imported.
    """
    discover()
    if _failed:
        name, _, exc = _failed[0]
        raise PluginError(name, exc)
    folder = str(Path(project_dir).resolve())
    added = folder not in sys.path
    if added:
        sys.path.insert(0, folder)
    imported: list[str] = []
    try:
        for module in modules:
            try:
                importlib.import_module(module)
            except Exception as exc:
                raise PluginError(module, exc) from exc
            imported.append(module)
    finally:
        if added:
            sys.path.remove(folder)
    return imported


def plugin_listing() -> list[dict[str, str]]:
    """Every loaded extension point as {kind, name, module, level}."""
    from pandion.registry import registry
    from pandion.routing import CHECKS

    discover()
    rows: list[dict[str, str]] = []
    for stage in registry.stages():
        for name, cls in sorted(registry.all_for(stage).items()):
            rows.append(
                {
                    "kind": "step",
                    "name": f"{stage}/{name}",
                    "module": cls.__module__,
                    "level": "provisional",
                }
            )
    for name, check in sorted(CHECKS.items()):
        rows.append(
            {"kind": "route check", "name": name, "module": check.fn.__module__, "level": "stable"}
        )
    from pandion.index_store import store_class, store_names

    for name in store_names():
        rows.append({"kind": "store", "name": name, "module": store_class(name).__module__, "level": "stable"})
    from pandion.document_sources import source_class, source_names

    for name in source_names():
        rows.append({"kind": "source", "name": name, "module": source_class(name).__module__, "level": "stable"})
    return rows
