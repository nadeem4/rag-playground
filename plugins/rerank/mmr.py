"""Maximal Marginal Relevance: the rerank stage at zero dependency cost.

MMR needs no model of its own, which is the point of shipping it first. A
cross-encoder is the reranker people actually want, but it is a 500MB download
and an inference budget; this one is arithmetic over vectors that already exist
(the index's embedder, read back from the embedding cache), so the *stage* (its
ports, its ambient query and index bindings, its rank-movement reporting) is
proven end to end before any of that weight arrives.

Relevance is the retriever's own score, normalised to 0..1 across the pool, and
only redundancy is judged with vectors. Recomputing relevance as the dense
cosine threw away the keyword half of a hybrid retrieval: a hit that hybrid
search put first could fall to fifth, and even `lambda_mult=1.0` returned the
dense order rather than the order it was handed.

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
from core.payloads import Hit, RetrievalResult
from core.ports import PortSpec, RunContext, Stage, set_note
from core.registry import register
from core.transform import Explanation, Transform
from plugins.retrieve import _base
from providers.embedding_cache import embed_cached


class MmrRerankConfig(BaseModel):
    #: 1.0 is pure relevance (the retriever's own order, kept exactly); 0.0 is
    #: pure diversity, which after the first pick ignores the question entirely.
    lambda_mult: float = 0.5
    #: How many it picks from the retriever's candidate pool (20 by default).
    top_k: int = 5

    # No `embedder` field. The model and width come from the index descriptor,
    # the same rule the retrievers follow: MMR judges similarity in the space
    # the hits were retrieved in, and there is no way to say a different one.


@register
class MmrRerank(Transform[MmrRerankConfig]):
    """`retrieval_result -> retrieval_result`, so it stacks with other rerankers."""

    name = "mmr"
    version = "2"
    stage = Stage.RERANK
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        # Ambient: the query reaches the reranker from a non-adjacent ancestor,
        # with no edge a linear column UI would have to draw. MMR does not embed
        # it (relevance is the retriever's score), but the port stays so a
        # different question still gives this node a different recipe.
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
        # Ambient too: the index says which embedder and which width. Its
        # artifact id is already an input to this node's recipe hash, so a
        # different model or width moves the id with no fingerprint of its own.
        "index": PortSpec(ArtifactType.INDEX, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    config_model = MmrRerankConfig
    summary = (
        "Maximal Marginal Relevance picks results one at a time, each time taking "
        "the piece the retriever scored highest while being least like the "
        "pieces already picked. It trades a little relevance for variety, and it "
        "reuses the index's own vectors to judge likeness, so it needs no extra "
        "model."
    )

    def explain(self, config: MmrRerankConfig) -> Explanation:
        lam, top = config.lambda_mult, config.top_k
        if lam >= 1:
            meaning = "pure relevance, so the retriever's own order is kept"
        elif lam <= 0:
            meaning = "pure variety: after the first pick the question is ignored"
        else:
            meaning = (
                f"each pick weighs the retriever's score at {lam:.0%} and being "
                f"different from earlier picks at {1 - lam:.0%}"
            )
        settings = (
            f"lambda_mult is {lam:g}: {meaning}. Relevance is the retriever's "
            "score for each piece, scaled from 0 to 1 across the pool, so a "
            "keyword match found by hybrid search counts in full. Likeness "
            "between pieces is judged with the index's own vectors. It picks "
            f"{top} pieces from the candidate pool the retriever hands on (20 by "
            "default), and the first is always the retriever's top hit."
        )
        tradeoff = (
            "More variety means fewer near-duplicate hits, but a piece that "
            "repeats the best answer in other words may be dropped. MMR can only "
            f"choose when the pool is larger than {top}; a pool of {top} or fewer "
            "is merely reordered."
        )
        warning, blocking = None, False
        if not 0 <= lam <= 1:
            warning, blocking = (
                "lambda_mult must be between 0 and 1; outside that range the "
                "formula rewards repetition or penalises relevance.",
                True,
            )
        elif top < 1:
            warning, blocking = "top_k must be at least 1.", True
        return Explanation(
            settings=settings, tradeoff=tradeoff, warning=warning, blocking=blocking
        )

    def apply(
        self, inputs: Mapping[str, Any], config: MmrRerankConfig, ctx: RunContext
    ) -> dict[str, Any]:
        result = RetrievalResult.model_validate(inputs["result"])
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

        # Relevance is the retriever's judgement, whatever produced it: a cosine,
        # a BM25 score or a small, close RRF score. Min-max puts them all on 0..1
        # without changing their order, so `lambda_mult=1.0` is the incoming
        # order exactly. A pool with no spread (one hit, or all equal) is all 1.0.
        relevance = _normalise([hit.score for hit in hits])

        descriptor = _base.read_descriptor(inputs["index"])
        embedder, dim = _base.embedder_for(descriptor)
        # Re-embedding the hits goes through the embedding cache, where the
        # index build already left every chunk's document vector, so with a
        # real model this is a lookup rather than inference. `text_to_embed` is
        # used so the contextual-retrieval seam holds: the augmented text is
        # what was retrieved on, so it is what MMR must judge likeness on.
        doc_vectors, _ = embed_cached(
            embedder,
            [hit.chunk.text_to_embed for hit in hits],
            kind="document",
            dim=dim,
        )
        vectors = np.asarray(doc_vectors, dtype=float)

        # Vectors arrive L2-normalized, so a dot product is already the cosine.
        similarity = vectors @ vectors.T

        selected = _select(relevance, similarity, config.lambda_mult, config.top_k)

        result.hits = [
            _at_rank(hits[index], rank) for rank, index in enumerate(selected, start=1)
        ]
        # The pool MMR chose from, so "5 results from 20 candidates" is true.
        result.total_candidates = len(hits)
        set_note(ctx, _note(result.hits))
        return result.model_dump(mode="json")


def _normalise(scores: list[float]) -> np.ndarray:
    """Min-max to 0..1; with no spread every candidate is fully relevant."""
    values = np.asarray(scores, dtype=float)
    spread = values.max() - values.min()
    if spread <= 0:
        return np.ones_like(values)
    return (values - values.min()) / spread


def _note(picked: list[Hit]) -> str:
    """One sentence on what the pass did, counted against the incoming ranks."""
    moved = sum(1 for hit in picked if hit.rank != hit.prior_rank)
    source = "relevance from the retriever's scores."
    if moved == 0:
        return f"Kept the retriever's order for the top {len(picked)}, {source}"
    return f"Reordered {moved} of the top {len(picked)} by variety, {source}"


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
