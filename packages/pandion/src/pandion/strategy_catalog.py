"""Every strategy Pandion knows, the default for each part, and what one will do.

`catalog()` is what an app needs to draw a settings form: for each stage, each
strategy's summary, inputs and settings as a JSON schema with defaults.
`defaults()` names the strategy a new pipeline starts with for each required
part, keyed as in the pipeline file. `explain()` says in plain words what one
strategy will do with given settings, without running anything.
"""

from __future__ import annotations

import copy
from typing import Any

from pandion.config import ConfigError
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import UnknownTransformError, registry
from pandion.stages import _strategy

#: The strategy each required part of a new pipeline starts with: Docling reads
#: layout, hybrid search fuses keyword and meaning, and the search answer needs
#: no model or key.
DEFAULTS: dict[str, str] = {
    "parse": "docling",
    "chunk": "recursive_character",
    "embed": "qwen3-embedding-0.6b",
    "store": "lancedb",
    "search": "hybrid_rrf",
    "answer": "search",
}


def catalog() -> dict[str, dict[str, dict[str, Any]]]:
    """Every registered strategy by stage, with its settings as a JSON schema.

    It is a copy: changing it changes nothing in Pandion.
    """
    discover()
    return copy.deepcopy(registry.export_schema())


def defaults() -> dict[str, str]:
    """The strategy each required part of a new pipeline starts with."""
    return dict(DEFAULTS)


def explain(stage: str, use: str, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """What the `use` strategy of `stage` will do with `settings`, in plain words.

    Nothing runs and no model loads. An unknown stage or strategy is a
    KeyError; a setting it does not have, or a value it does not accept, is a
    ConfigError.
    """
    discover()
    try:
        kind = Stage(stage)
    except ValueError:
        stages = ", ".join(s.value for s in Stage)
        raise KeyError(f"'{stage}' is not a stage. The stages are: {stages}.") from None
    try:
        cls, config = _strategy(kind, use, dict(settings or {}), where=stage)
    except UnknownTransformError as exc:
        raise KeyError(exc.args[0]) from None
    except ValueError as exc:
        raise ConfigError(str(exc), use=use, settings=getattr(exc, "settings", None)) from None
    return cls().explain(config).model_dump()
