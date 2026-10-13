"""Everything you need to write your own strategy for any stage.

A strategy is a class: its stage, what it reads (`inputs`), what it makes
(`output`, fixed by the stage), a settings model where every field has a
default, one plain sentence (`summary`), and `apply()`. Decorate it with
`@register` and its `name` works in YAML and in `Pipeline(...)` like a
built-in. `@register` also takes an `Embedder` subclass, which adds an
embedder that `embed: {use: <its name>}` can pick. See docs/pandion.md,
"Write your own strategy", and examples/pandion/own_strategies/ for one
strategy per stage.
"""

from typing import Any

from pandion.artifacts import ArtifactType
from pandion.embeddings import Embedder, get_embedder, register_embedder
from pandion.payloads import Chunk, ChunkSet, Element, Hit, Output, ParsedDoc, Query, RetrievalResult
from pandion.ports import PortSpec, RunContext, Stage, set_note
from pandion.registry import register as _register_transform
from pandion.sources import raw_file
from pandion.transform import Explanation, Transform

__all__ = [
    "ArtifactType", "Chunk", "ChunkSet", "Element", "Embedder", "Explanation", "Hit",
    "Output", "ParsedDoc", "PortSpec", "Query", "RetrievalResult", "RunContext", "Stage",
    "Transform", "get_embedder", "raw_file", "register", "set_note",
]


def register(cls: Any) -> Any:
    """Add a strategy (a Transform) or an embedder, so its name works in YAML and code."""
    if isinstance(cls, type) and issubclass(cls, Embedder):
        return register_embedder(cls)
    if isinstance(cls, type) and issubclass(cls, Transform):
        return _register_transform(cls)
    raise TypeError(f"register takes a Transform or an Embedder subclass, not {cls!r}.")
