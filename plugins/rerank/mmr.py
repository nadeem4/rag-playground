"""Maximal Marginal Relevance: the rerank stage at zero dependency cost.

MMR needs no model of its own, which is the point of shipping it first. A
cross-encoder is the reranker people actually want, but it is a 500MB download
and an inference budget; this one is arithmetic over vectors that already exist
(the index's embedder, read back from the embedding cache), so the *stage* (its
ports, its ambient query and index bindings, its rank-movement reporting) is
proven end to end before any of that weight arrives.

The rank movement is the pedagogy. Every returned hit carries `prior_rank` and
`prior_score` from its pre-rerank position, so the bench can draw the arrows
that show what the reranker actually did. A reranker that only reordered a list
would be indistinguishable from a broken one.
"""

from __future__ import annotations

from typing import Any, Mapping

import numpy as np
from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import Hit, Query, RetrievalResult
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Transform
from plugins.retrieve import _base
from providers.embedding_cache import embed_cached


class MmrRerankConfig(BaseModel):
    #: 1.0 is pure relevance (the retriever's own order, recomputed); 0.0 is
    #: pure diversity, which after the first pick ignores the query entirely.
    lambda_mult: float = 0.5
    top_k: int = 5

    # No `embedder` field. The model and width come from the index descriptor,
    # the same rule the retrievers follow: MMR judges similarity in the space
    # the hits were retrieved in, and there is no way to say a different one.


@register
class MmrRerank(Transform[MmrRerankConfig]):
    """`retrieval_result -> retrieval_result`, so it stacks with other rerankers."""

    name = "mmr"
    version = "1"
    stage = Stage.RERANK
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        # Ambient: the query reaches the reranker from a non-adjacent ancestor,
        # with no edge a linear column UI would have to draw.
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
        # Ambient too: the index says which embedder and which width. Its
        # artifact id is already an input to this node's recipe hash, so a
        # different model or width moves the id with no fingerprint of its own.
        "index": PortSpec(ArtifactType.INDEX, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    config_model = MmrRerankConfig

    def apply(
        self, inputs: Mapping[str, Any], config: MmrRerankConfig, ctx: RunContext
    ) -> dict[str, Any]:
        result = RetrievalResult.model_validate(inputs["result"])
        query = Query.model_validate(inputs["query"])
        hits = result.hits

        if not hits:
            return result.model_dump(mode="json")

        # Every hit is stamped with where it stood *before* this pass, while the
        # incoming order is still intact. Doing it here rather than at selection
        # time means a hit dropped by `top_k` never silently loses its history.
        # `score` itself is left alone: MMR reorders, it does not rescore, and
        # its objective value is not a relevance a UI could compare across hits.
        for hit in hits:
            hit.prior_rank = hit.rank
            hit.prior_score = hit.score

        descriptor = _base.read_descriptor(inputs["index"])
        embedder, dim = _base.embedder_for(descriptor)
        # Re-embedding the hits goes through the embedding cache, where the
        # index build already left every chunk's document vector, so with a
        # real model this is a lookup rather than inference. `text_to_embed` is
        # used so the contextual-retrieval seam holds: the augmented text is
        # what was retrieved on, so it is what MMR must judge.
        doc_vectors, _ = embed_cached(
            embedder,
            [hit.chunk.text_to_embed for hit in hits],
            kind="document",
            dim=dim,
        )
        vectors = np.asarray(doc_vectors, dtype=float)
        query_text, query_kind = _base.query_embedding_input(query)
        query_vectors, _ = embed_cached(
            embedder, [query_text], kind=query_kind, dim=dim
        )
        query_vec = np.asarray(query_vectors[0], dtype=float)

        # Vectors arrive L2-normalized, so a dot product is already the cosine.
        relevance = vectors @ query_vec
        similarity = vectors @ vectors.T

        selected = _select(relevance, similarity, config.lambda_mult, config.top_k)

        result.hits = [
            _at_rank(hits[index], rank) for rank, index in enumerate(selected, start=1)
        ]
        return result.model_dump(mode="json")


def _select(
    relevance: np.ndarray, similarity: np.ndarray, lambda_mult: float, top_k: int
) -> list[int]:
    """Indices, in MMR order.

    The first pick is pure relevance: at `lambda_mult=0` the MMR score of an
    empty selection is undefined (there is nothing to be redundant with), and
    seeding with the best-matching document is what makes "diversify the results
    for this query" mean anything at all.

    Ties fall to the lower index, so the retriever's order breaks them and the
    whole function is deterministic.
    """
    candidates = list(range(len(relevance)))
    selected: list[int] = [int(np.argmax(relevance))]
    candidates.remove(selected[0])

    limit = min(top_k, len(relevance))
    while candidates and len(selected) < limit:
        redundancy = similarity[np.ix_(candidates, selected)].max(axis=1)
        scores = lambda_mult * relevance[candidates] - (1.0 - lambda_mult) * redundancy
        selected.append(candidates.pop(int(np.argmax(scores))))

    return selected


def _at_rank(hit: Hit, rank: int) -> Hit:
    hit.rank = rank
    return hit
