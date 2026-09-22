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

#: What each step is for in RAG, in one plain paragraph. The UI shows it in
#: every card's explanation, so a newcomer learns the pipeline by reading it.
STAGE_WHAT: dict[Stage, str] = {
    Stage.SOURCE: (
        "Every RAG pipeline starts from the documents you want to ask questions "
        "about. This step picks the file. It is stored once, by the fingerprint "
        "of its bytes, so the same file used in many pipelines is kept only once."
    ),
    Stage.QUERY: (
        "The question you want answered. Retrieval looks for the pieces of your "
        "document that best match it, so the wording matters: a question that "
        "uses the document's own terms is easier to match."
    ),
    Stage.PARSE: (
        "A PDF stores letters at positions on a page, not paragraphs or "
        "headings. Parsing turns it into a structured document of blocks "
        "(paragraphs, headings, tables) that every later step works from."
    ),
    Stage.CLEAN: (
        "Parsed documents carry noise: running heads, page numbers, repeated "
        "boilerplate. Cleaning removes blocks that would otherwise end up inside "
        "the pieces you search, where they add nothing and crowd out real "
        "matches. Cleaners can be stacked, one after another."
    ),
    Stage.CHUNK: (
        "A retriever never returns your whole document, only pieces of it. "
        "Chunking decides where those pieces start and end, and that decides "
        "what one search hit can contain."
    ),
    Stage.ENRICH: (
        "Enrichment adds context to each piece before it is indexed, for "
        "example a line saying which document and section it came from, so a "
        "piece that makes little sense on its own can still be found. No "
        "enricher is available yet."
    ),
    Stage.INDEX: (
        "Indexing makes the pieces searchable. Each piece is turned into a "
        "vector, a list of numbers that captures its meaning, and optionally "
        "into a keyword index as well. Searches later compare the question "
        "against these."
    ),
    Stage.QUERY_TRANSFORM: (
        "A query transform rewrites the question before retrieval, for example "
        "into several phrasings or into a made-up answer that looks more like "
        "the document text. It helps when the question and the document use "
        "different words. No query transform is available yet."
    ),
    Stage.RETRIEVE: (
        "Retrieval finds the pieces that best match the question: by meaning "
        "(vectors), by shared keywords, or by both. Only the pieces it returns "
        "can reach the answer, so a fact it misses cannot be used later."
    ),
    Stage.RERANK: (
        "Reranking takes the retrieved pieces and puts them in a better order, "
        "or picks a better subset, before they are used. It sees only what "
        "retrieval returned, so it can reorder but never recover a missed piece."
    ),
    Stage.USE_CASE: (
        "The last step turns the retrieved pieces into something you use: a "
        "list of search results, or an answer written by a language model that "
        "cites the pieces it relied on."
    ),
}

#: The longer lesson Learn mode shows at the top of a stage's card, as
#: paragraphs. Only stages whose lesson is written appear here.
STAGE_LESSON: dict[Stage, list[str]] = {
    Stage.CHUNK: [
        "Before a search can find anything, the document is cut into smaller "
        "pieces called chunks. The search compares your question with each chunk "
        "and returns the ones that match best.",
        "So the way you cut the document decides what the search can find. If "
        "the answer to a question is cut in half, neither half may match well "
        "enough to be found.",
    ],
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

    `extras` starts as a copy of the run's `context_extras` (for example
    `{"credentials": {"anthropic_api_key": ...}}`). A transform may set
    `extras["meta"]`, the only key the executor copies into artifact meta.
    """

    output_dir: Path
    emit: Callable[[dict[str, Any]], None]
    tmp: Path
    extras: dict[str, Any] = field(default_factory=dict)


def set_note(ctx: RunContext | None, text: str) -> None:
    """Record one plain sentence about something noteworthy in this run (I-13).

    It lands in `ctx.extras["meta"]["note"]`, which the executor copies into
    the artifact's meta. A `None` ctx (a plugin called directly in a test) is
    tolerated, because the note is information, never behaviour.
    """
    if ctx is None:
        return
    ctx.extras.setdefault("meta", {})["note"] = text
