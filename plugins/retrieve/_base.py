"""What all three retrievers share.

**A retriever never decides how to embed a query.** The index already made that
decision — model, revision and vector width — and wrote it into `descriptor.json`
when it was built. Every retriever reads it back from there, which is why none of
the three config models has an `embedder` or a `truncate_dim` field: with no way
to say it, there is no way to say something different from the index. Otherwise a
sweep that re-points a retriever at a 256-dim index while its own config still
says 1024 would either crash deep inside the vector store or, worse, return
plausible nonsense.

The same argument applies to the *backend*. `Transform.provides` is a static
class claim — `lancedb` says `["dense", "fts"]` because it *can* build both — but
an index built with `build_fts=False` has no full-text side at run time. Graph
validation compares the claim, so the descriptor is checked again here, where the
truth is.
"""

from __future__ import annotations

import hashlib
import json
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import lancedb

from core.ids import canonical_json
from core.payloads import Chunk, Hit, Query, RetrievalResult
from plugins.index.lancedb_store import DESCRIPTOR, TABLE
from providers.embedding_cache import embed_cached
from providers.embeddings import EmbedKind, EmbeddingProvider, get_embedder


def open_index(raw: Any) -> tuple[Any, dict[str, Any]]:
    """Return `(table, descriptor)` for the index directory the executor loaded.

    The `index` port arrives as a `Path`: `DirectorySerializer.read` hands back
    the committed directory and the consumer opens it, so the store never holds
    a database handle of its own.
    """
    directory = Path(raw)
    return lancedb.connect(directory).open_table(TABLE), read_descriptor(directory)


def read_descriptor(raw: Any) -> dict[str, Any]:
    """The index's `descriptor.json`, without opening the database.

    For consumers such as MMR that need the model and width but no search.
    """
    return json.loads((Path(raw) / DESCRIPTOR).read_text(encoding="utf-8"))


def require_backend(descriptor: dict[str, Any], backend: str, retriever: str) -> None:
    """Fail loudly when the index has no side this retriever can read."""
    backends = descriptor.get("backends", [])
    if backend not in backends:
        raise ValueError(
            f"retriever '{retriever}' needs the '{backend}' backend, but this "
            f"index was built with {backends or 'no backends'}. A transform's "
            f"`provides` is a static claim about what it can build; this index "
            f"did not build it. Rebuild with build_fts=True (for 'fts'), or "
            f"wire a retriever that does not need '{backend}'."
        )


def embedder_for(descriptor: dict[str, Any]) -> tuple[EmbeddingProvider, int | None]:
    """The embedder the index was built with, and the width to truncate to.

    A revision mismatch is refused rather than warned about: the name still
    resolves, the vectors still have the right width, and the results would be
    quietly worse — the exact failure mode the fingerprint exists to prevent.
    """
    embedder = get_embedder(descriptor["embedding_model"])
    if embedder.revision != descriptor["embedding_revision"]:
        raise ValueError(
            f"index was built with {descriptor['embedding_model']} revision "
            f"{descriptor['embedding_revision']!r}, but the installed provider "
            f"is revision {embedder.revision!r}. Those vectors are not "
            f"comparable; rebuild the index."
        )

    dim, native = descriptor["dim"], descriptor["native_dim"]
    return embedder, (None if dim == native else dim)


def query_embedding_input(query: Query) -> tuple[str, EmbedKind]:
    """What to embed for a query, and as which kind. The one rule, spec I-4.

    A HyDE transform writes a hypothetical *document* into `embed_text`, so it
    is embedded as a document: the query instruction would tell an asymmetric
    model to treat a passage as a question. Otherwise the user's question is
    embedded with the model's query instruction. Retrievers and rerankers both
    come through here, so they can never disagree.
    """
    if query.embed_text is not None:
        return query.embed_text, "document"
    return query.text, "query"


def embed_query(descriptor: dict[str, Any], query: Query) -> list[float] | None:
    """The query vector, in the index's own model and width.

    `None` for a blank query: an instruction-aware model would happily embed
    the bare instruction and return plausible-looking hits for nothing at all.
    """
    text, kind = query_embedding_input(query)
    if not text.strip():
        return None
    embedder, truncate_dim = embedder_for(descriptor)
    vectors, _ = embed_cached(embedder, [text], kind=kind, dim=truncate_dim)
    return vectors[0]


def dense_rows(
    table: Any, vector: list[float] | None, descriptor: dict[str, Any], limit: int
) -> list[dict[str, Any]]:
    """Vector search, using the distance type the index declared.

    No ANN index is built, so the distance type is chosen per query — and it must
    be the one the index was *declared* with, or the ranking is measured against
    a geometry the vectors were never normalized for.
    """
    if vector is None:
        return []
    return (
        table.search(vector)
        .distance_type(descriptor["metric"])
        .limit(limit)
        .to_list()
    )


def fts_rows(table: Any, query: Query, limit: int) -> list[dict[str, Any]]:
    """Full-text search on the same rows the vectors were built from.

    Lexical matching runs on `query.text`, never on `embed_text`: a hypothetical
    document is useful as a vector and actively harmful as a bag of keywords.
    """
    if not query.text.strip():
        return []
    return table.search(query.text, query_type="fts").limit(limit).to_list()


def similarity(distance: float, metric: str) -> float:
    """A distance turned into a score where higher is better.

    `Hit.score` is sorted descending everywhere downstream, so the sign has to be
    fixed here rather than at each consumer.
    """
    return 1.0 - distance if metric == "cosine" else -distance


def make_hit(
    row: dict[str, Any],
    *,
    rank: int,
    score: float,
    retriever: str,
    component_scores: dict[str, float] | None = None,
) -> Hit:
    """Rebuild the full chunk, so the citation carries the *original* text.

    The indexed `text` column holds `chunk.text_to_embed`, which under contextual
    retrieval is an augmented string that was never in the document. `chunk_json`
    is the canonical chunk, offsets and provenance included.
    """
    chunk = Chunk.model_validate(json.loads(row["chunk_json"]))
    return Hit(
        chunk=chunk,
        score=float(score),
        rank=rank,
        matched_chunk_id=row["id"],
        retriever=retriever,
        component_scores=component_scores or {},
    )


def query_id(query: Query) -> str:
    """A stable id for the question, so results can be grouped across retrievers."""
    return hashlib.sha256(
        canonical_json(query.model_dump(mode="json")).encode("utf-8")
    ).hexdigest()[:16]


@contextmanager
def timed(timings: dict[str, float], key: str) -> Iterator[None]:
    start = time.perf_counter()
    try:
        yield
    finally:
        timings[key] = (time.perf_counter() - start) * 1000.0


def result(
    hits: list[Hit],
    *,
    query: Query,
    fetch_k: int,
    total_candidates: int,
    timings_ms: dict[str, float],
) -> dict[str, Any]:
    return RetrievalResult(
        hits=hits,
        query_id=query_id(query),
        fetch_k=fetch_k,
        total_candidates=total_candidates,
        timings_ms=timings_ms,
    ).model_dump(mode="json")
