"""Maximal Marginal Relevance: the rerank stage at zero dependency cost.

MMR needs no model and no download, which is the point of shipping it first. A
cross-encoder is the reranker people actually want, but it is a 500MB download
and an inference budget; this one is pure arithmetic over vectors that already
exist, so the *stage* — its ports, its ambient query binding, its rank-movement
reporting — is proven end to end before any of that weight arrives.

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
from providers.embeddings import get_embedder


class MmrRerankConfig(BaseModel):
    #: 1.0 is pure relevance (the retriever's own order, recomputed); 0.0 is
    #: pure diversity, which after the first pick ignores the query entirely.
    lambda_mult: float = 0.5
    top_k: int = 5

    embedder: str = "fake-deterministic"


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
    }
    output = ArtifactType.RETRIEVAL_RESULT
    config_model = MmrRerankConfig

    def fingerprint(self, config: MmrRerankConfig | None = None) -> str:
        """The embedder's identity: different vectors, different selection.

        Reads the node's own config, not the default — otherwise changing a
        node's embedder would not move the artifact id.
        """
        cfg = config or self.config_model()
        return get_embedder(cfg.embedder).fingerprint()

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

        embedder = get_embedder(config.embedder)
        # Phase 3 optimization: read these vectors back from the index instead.
        # Re-embedding is wasteful in principle — the index already holds the
        # exact vectors these chunks were stored with — but it is free with the
        # fake embedder and keeps the reranker independent of the index backend.
        # `text_to_embed` is used so the contextual-retrieval seam holds: the
        # augmented text is what was retrieved on, so it is what MMR must judge.
        vectors = np.asarray(
            embedder.embed([hit.chunk.text_to_embed for hit in hits]), dtype=float
        )
        query_vec = np.asarray(
            embedder.embed([query.embed_text or query.text])[0], dtype=float
        )

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
