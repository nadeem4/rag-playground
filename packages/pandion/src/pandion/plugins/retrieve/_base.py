"""What all three retrievers share.

**A retriever never decides how to embed a query.** The index already made that
decision — model, revision and vector width — and wrote it into the index descriptor
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
import logging
from typing import Any, Iterator, Mapping

from pandion import filters as _filters
from pandion.ids import canonical_json
from pandion.index_store import (
    AnyOf,
    Binding,
    Collection,
    Filter,
    StoreHit,
    binding_settings,
    check_store,
    get_store,
    matches,
    open_binding,
)
from pandion.payloads import Chunk, Hit, Query, RetrievalResult
from pandion.embedding_cache import embed_cached
from pandion.embeddings import EmbedKind, EmbeddingProvider, get_embedder
from pandion.models import ModelSettings


def _limits_warning(top_k: int) -> tuple[str | None, bool]:
    """(warning, blocking) for the pool size every retriever takes."""
    if top_k < 1:
        return "top_k must be at least 1.", True
    return None, False


def pool_words(top_k: int) -> str:
    """What happens to the pool a retriever hands on."""
    return (
        f"All {top_k} are handed on as a candidate pool; a reranker or the use "
        "case after this step picks its own, smaller top from them."
    )


TOP_K_TRADEOFF = (
    "Retrieve wide, narrow later: a larger pool gives a reranker more to choose "
    "from and makes it likelier the right piece is in it at all, but the "
    "search and any reranking take a little longer. The number of pieces a "
    "person reads, or a chat answer uses, is set by the step that narrows it."
)


#: Rows the expansion step weighs words against: a bounded search, because the
#: store contract has no scan.
PRF_POOL = 1000

_access_log = logging.getLogger("pandion.access")


def open_index(raw: Any, extras: Mapping[str, Any] | None = None) -> tuple[Collection, dict[str, Any]]:
    """Return `(collection, descriptor)` for the index binding the executor loaded.

    The `index` port arrives as the small JSON binding the index step wrote:
    the store, its settings and the collection that holds the rows.
    """
    location = (extras or {}).get("index_location")
    return open_binding(raw, location), read_descriptor(raw)


def read_descriptor(raw: Any) -> dict[str, Any]:
    """The index's descriptor, from its binding, without opening the store.

    For consumers such as MMR that need the model and width but no search.
    """
    return dict(raw["descriptor"])


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


def check_pairing(
    raw: Any,
    descriptor: dict[str, Any],
    backend: str,
    retriever: str,
    roles: list[str] | None,
    query: Query | None = None,
    extras: Mapping[str, Any] | None = None,
) -> None:
    """Refuse an index this retriever cannot read, with one plain sentence.

    The index must have built the side the retriever reads, and its store must
    be able to serve it: a text search for `fts`, the index's distance metric,
    and, when access is on, filtering by any of a list of roles. There is no
    Pandion-side text-search fallback.
    """
    require_backend(descriptor, backend, retriever)
    binding = Binding.model_validate(raw)
    caps = get_store(
        binding.store, binding_settings(raw, (extras or {}).get("index_location"))
    ).capabilities()
    # The filters the retrievers send are combined with "and"; a document
    # filter is a list, so it needs "in".
    if "and" not in caps.filters:
        raise ValueError(
            f"The {binding.store} store cannot combine filters, so it cannot serve a search. Use another store."
        )
    if (query is not None and (query.filters or {}).get("doc_ids")) and "in" not in caps.filters:
        raise ValueError(
            f"The {binding.store} store cannot filter by a list, so it cannot serve a document filter. "
            "Use another store."
        )
    if roles is None and "any_of" not in caps.filters:
        # Access is off: the store need not filter by roles.
        caps = caps.model_copy(update={"filters": caps.filters | {"any_of"}})
    check_store(binding.store, caps, lexical=backend == "fts", metric=descriptor.get("metric"))


def embedder_for(
    descriptor: dict[str, Any], models: ModelSettings | None = None
) -> tuple[EmbeddingProvider, int | None]:
    """The embedder the index was built with, and the width to truncate to.

    `models` is the run's model settings (`ctx.extras["models"]`), so a query
    is embedded on the same device as the index was.

    A revision mismatch is refused rather than warned about: the name still
    resolves, the vectors still have the right width, and the results would be
    quietly worse — the exact failure mode the fingerprint exists to prevent.
    """
    embedder = get_embedder(descriptor["embedding_model"], models)
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


def embed_query(
    descriptor: dict[str, Any], query: Query, extras: Mapping[str, Any] | None = None
) -> list[float] | None:
    """The query vector, in the index's own model and width.

    `extras` is the run's `ctx.extras`: its embedding cache and model settings
    are used when it has them.

    `None` for a blank query: an instruction-aware model would happily embed
    the bare instruction and return plausible-looking hits for nothing at all.
    """
    text, kind = query_embedding_input(query)
    if not text.strip():
        return None
    extras = extras or {}
    embedder, truncate_dim = embedder_for(descriptor, extras.get("models"))
    vectors, _ = embed_cached(
        embedder, [text], kind=kind, dim=truncate_dim, cache=extras.get("embedding_cache")
    )
    return vectors[0]


def caller_roles(query: Query, extras: Mapping[str, Any] | None) -> list[str] | None:
    """The roles to limit the search to, or None for no limit.

    The pipeline puts them in the run's extras; they are taken from there so a
    step that rewrites the question cannot lose them. Only a run with none
    (a step called on its own) falls back to the roles on the question.
    """
    extras = extras or {}
    if "roles" in extras:
        return extras["roles"]
    return (query.filters or {}).get("roles")


def search_filter(query: Query, descriptor: dict[str, Any], roles: list[str] | None) -> Filter:
    """The store filter for the question's filters on this index and the roles."""
    return _filters.store_filter(query.filters, roles, descriptor)


def recheck(hits: list[StoreHit], roles: list[str] | None, *, retriever: str) -> list[StoreHit]:
    """Keep only the rows the caller may read, whatever the store returned.

    The store was asked to filter by roles, and a buggy plugin may not have.
    A dropped row is logged by id, never by text.
    """
    if roles is None:
        return hits
    allowed = AnyOf("roles", tuple(roles))
    kept = []
    for hit in hits:
        if matches(hit.row, allowed):
            kept.append(hit)
        else:
            _access_log.warning(
                "dropped row %s of %s: roles did not match (retriever %s)",
                hit.row.id, hit.row.doc_id, retriever,
            )
    return kept


def dense_hits(
    collection: Collection,
    vector: list[float] | None,
    limit: int,
    where: Filter,
    roles: list[str] | None,
    retriever: str,
) -> list[StoreHit]:
    """Vector search through the store, then the role re-check."""
    if vector is None:
        return []
    return recheck(collection.search_dense(vector, limit, where), roles, retriever=retriever)


def lexical_hits(
    collection: Collection,
    query: Query,
    limit: int,
    where: Filter,
    roles: list[str] | None,
    retriever: str,
    text: str | None = None,
) -> list[StoreHit]:
    """Full-text search through the store, then the role re-check.

    Lexical matching runs on `query.text`, never on `embed_text`: a hypothetical
    document is useful as a vector and actively harmful as a bag of keywords.
    `text` overrides it for this search only, for an expanded keyword query
    (PRF); a blank question still searches nothing.
    """
    if not query.text.strip():
        return []
    terms = query.text if text is None else text
    return recheck(collection.search_lexical(terms, limit, where), roles, retriever=retriever)


def make_hit(
    hit: StoreHit,
    *,
    rank: int,
    score: float,
    retriever: str,
    component_scores: dict[str, float] | None = None,
) -> Hit:
    """Rebuild the full chunk, so the citation carries the *original* text.

    The indexed `text` holds `chunk.text_to_embed`, which under contextual
    retrieval is an augmented string that was never in the document. The row's
    `chunk` is the canonical chunk, offsets and provenance included.
    """
    chunk = Chunk.model_validate(json.loads(hit.row.chunk))
    return Hit(
        chunk=chunk,
        score=float(score),
        rank=rank,
        matched_chunk_id=hit.row.id,
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
    total_candidates: int,
    fetch_k: int,
    timings_ms: dict[str, float],
    expanded_query: str | None = None,
    expansion_terms: list[str] | None = None,
) -> dict[str, Any]:
    return RetrievalResult(
        hits=hits,
        query_id=query_id(query),
        fetch_k=fetch_k,
        total_candidates=total_candidates,
        timings_ms=timings_ms,
        expanded_query=expanded_query,
        expansion_terms=expansion_terms or [],
    ).model_dump(mode="json")
