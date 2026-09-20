"""Stages, input ports, and the per-node execution context."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Callable

from core.artifacts import ArtifactType


class Stage(StrEnum):
    """The slots a transform can plug into."""

    SOURCE = "source"
    QUERY = "query"
    PARSE = "parse"
    CLEAN = "clean"
    CHUNK = "chunk"
    ENRICH = "enrich"
    INDEX = "index"
    QUERY_TRANSFORM = "query_transform"
    RETRIEVE = "retrieve"
    RERANK = "rerank"
    USE_CASE = "use_case"


#: The artifact type each stage must produce. Enforced at class-definition time.
STAGE_OUTPUT: dict[Stage, ArtifactType] = {
    Stage.SOURCE: ArtifactType.RAW_FILE,
    Stage.QUERY: ArtifactType.QUERY,
    Stage.PARSE: ArtifactType.PARSED_DOC,
    Stage.CLEAN: ArtifactType.PARSED_DOC,
    Stage.CHUNK: ArtifactType.CHUNK_SET,
    Stage.ENRICH: ArtifactType.CHUNK_SET,
    Stage.INDEX: ArtifactType.INDEX,
    Stage.QUERY_TRANSFORM: ArtifactType.QUERY,
    Stage.RETRIEVE: ArtifactType.RETRIEVAL_RESULT,
    Stage.RERANK: ArtifactType.RETRIEVAL_RESULT,
    Stage.USE_CASE: ArtifactType.OUTPUT,
}

#: Stages whose input type equals their output type, so they may repeat.
#: Cleaners stack, enrichers stack, query transforms stack, rerankers stack.
STACKABLE: frozenset[Stage] = frozenset(
    {Stage.CLEAN, Stage.ENRICH, Stage.QUERY_TRANSFORM, Stage.RERANK}
)


@dataclass(frozen=True)
class PortSpec:
    """A declared input port on a transform.

    `variadic` gives fan-in: an index node consuming many chunk sets is how a
    corpus works, and N-way score fusion depends on the same thing.

    `ambient` binds the port to the unique *terminal* producer of this type in
    the graph — excluding the consumer itself and its descendants, which would
    make the binding a cycle — rather than needing an explicit edge. Zero
    candidates (when the port is required) or more than one is an error, never a
    guess. Rerank needs the query and enrich needs the source doc — both are
    edges from non-adjacent ancestors that a linear column UI cannot draw. One
    mechanism, no user-visible wiring, and it degrades to an explicit edge when
    the canvas ships.
    """

    type: ArtifactType
    variadic: bool = False
    ambient: bool = False
    required: bool = True


@dataclass
class RunContext:
    """Everything a transform is handed besides its inputs and config.

    `output_dir` exists because an index transform cannot return a database
    handle as a value for the executor to serialize — it must write into a
    directory it is given.

    `emit` is called from a worker thread (the executor runs CPU-bound
    transforms off the event loop), so an async consumer must marshal via
    `loop.call_soon_threadsafe`.
    """

    output_dir: Path
    emit: Callable[[dict[str, Any]], None]
    tmp: Path
    extras: dict[str, Any] = field(default_factory=dict)
