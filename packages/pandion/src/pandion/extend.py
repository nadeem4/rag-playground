"""Everything you need to write your own strategy for any stage.

A strategy is a class: its stage, what it reads (`inputs`), what it makes
(`output`, fixed by the stage), a settings model where every field has a
default, one plain sentence (`summary`), and `apply()`. Decorate it with
`@register` and its `name` works in YAML and in `Pipeline(...)` like a
built-in. See docs/pandion.md, "Write your own strategy", and
examples/pandion/own_strategies/ for one strategy per stage.
"""

from pandion.artifacts import ArtifactType
from pandion.payloads import Chunk, ChunkSet, Element, Hit, Output, ParsedDoc, Query, RetrievalResult
from pandion.ports import PortSpec, RunContext, Stage, set_note
from pandion.registry import register
from pandion.transform import Explanation, Transform

__all__ = [
    "ArtifactType", "Chunk", "ChunkSet", "Element", "Explanation", "Hit", "Output",
    "ParsedDoc", "PortSpec", "Query", "RetrievalResult", "RunContext", "Stage",
    "Transform", "register", "set_note",
]
