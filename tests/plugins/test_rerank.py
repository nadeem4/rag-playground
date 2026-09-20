"""Contract tests for the MMR reranker.

Relevance is recomputed in the embedder's space, so the fixtures pin the numbers
they depend on rather than assuming them: `test_the_fixture_is_strictly_ordered`
fails loudly if the fake embedder ever changes and quietly invalidates the
ordering the rest of the file asserts on.
"""

from __future__ import annotations

import pytest

from core.artifacts import ArtifactType
from core.payloads import Chunk, Hit, Query, RetrievalResult
from core.ports import Stage
from core.registry import registry
from plugins.rerank.mmr import MmrRerank, MmrRerankConfig
from providers.embeddings import get_embedder

QUERY_TEXT = "What is the capital of France?"

#: Three near-duplicates about one fact, plus one unrelated passage. Ordered by
#: relevance to `QUERY_TEXT`, so a rank-preserving rerank is the identity.
NEAR_DUPLICATES: list[tuple[str, str]] = [
    ("a", "The capital of France is Paris."),
    ("b", "Paris, the capital of France, sits on the Seine river."),
    ("c", "France's capital city is Paris and it is quite large."),
]
DISTINCT: tuple[str, str] = ("d", "Volcanic soil retains moisture during dry summers.")

CANDIDATES: list[tuple[str, str]] = [*NEAR_DUPLICATES, DISTINCT]


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def relevance(text: str) -> float:
    """Cosine of `text` against the query, in the embedder's own space."""
    query_vec, text_vec = get_embedder("fake-deterministic").embed([QUERY_TEXT, text])
    return sum(a * b for a, b in zip(query_vec, text_vec))


def result(
    candidates: list[tuple[str, str]] = CANDIDATES, **extra
) -> dict:
    """A retrieval result as the executor delivers it: a plain JSON dict.

    Scores are the true query-document cosines, so the incoming ranking is the
    one a dense retriever over this embedder would really have produced.
    """
    hits = [
        Hit(
            chunk=Chunk(
                id=f"chunk-{key}",
                text=text,
                doc_id="doc-1",
                ordinal=i,
                source_element_ids=[f"el-{key}"],
                page_span=(1, 1),
            ),
            score=relevance(text),
            rank=i + 1,
            retriever="dense",
        )
        for i, (key, text) in enumerate(candidates)
    ]
    return RetrievalResult(
        hits=hits, query_id="q" * 16, fetch_k=len(hits), total_candidates=len(hits)
    ).model_dump(mode="json")


def rerank(payload: dict | None = None, query: str = QUERY_TEXT, **config) -> RetrievalResult:
    payload = result() if payload is None else payload
    out = MmrRerank().apply(
        {"result": payload, "query": Query(text=query).model_dump(mode="json")},
        MmrRerankConfig(**config),
        None,
    )
    return RetrievalResult.model_validate(out)


def keys(reranked: RetrievalResult) -> list[str]:
    return [hit.chunk.id.removeprefix("chunk-") for hit in reranked.hits]


# --------------------------------------------------------------------------
# registration
# --------------------------------------------------------------------------


def test_registered_under_the_rerank_stage():
    assert registry.get(Stage.RERANK, "mmr") is MmrRerank


def test_declares_a_result_port_and_an_ambient_query_port():
    assert MmrRerank.output is ArtifactType.RETRIEVAL_RESULT
    assert MmrRerank.inputs["result"].type is ArtifactType.RETRIEVAL_RESULT
    assert MmrRerank.inputs["result"].ambient is False
    assert MmrRerank.inputs["query"].type is ArtifactType.QUERY
    assert MmrRerank.inputs["query"].ambient is True


def test_config_defaults():
    cfg = MmrRerankConfig()
    assert cfg.lambda_mult == 0.5
    assert cfg.top_k == 5


# --------------------------------------------------------------------------
# the fixture's own assumptions
# --------------------------------------------------------------------------


def test_the_fixture_is_strictly_ordered_by_relevance():
    scores = [relevance(text) for _, text in CANDIDATES]
    assert scores == sorted(scores, reverse=True)
    assert len(set(scores)) == len(scores)


# --------------------------------------------------------------------------
# lambda: exploitation vs diversity
# --------------------------------------------------------------------------


def test_lambda_one_is_pure_relevance_order():
    assert keys(rerank(lambda_mult=1.0)) == ["a", "b", "c", "d"]


def test_lambda_one_preserves_relevance_order_from_a_shuffled_input():
    shuffled = [CANDIDATES[2], CANDIDATES[0], CANDIDATES[3], CANDIDATES[1]]
    assert keys(rerank(result(shuffled), lambda_mult=1.0)) == ["a", "b", "c", "d"]


def test_lambda_zero_promotes_the_distinct_candidate():
    """Pure diversity: after the top hit, the passage sharing nothing wins."""
    reranked = keys(rerank(lambda_mult=0.0))
    assert reranked[0] == "a"
    assert reranked[1] == "d"


def test_lambda_zero_pushes_the_nearest_duplicate_last():
    assert keys(rerank(lambda_mult=0.0))[-1] == "b"


# --------------------------------------------------------------------------
# rank movement
# --------------------------------------------------------------------------


def test_prior_rank_and_prior_score_are_populated_on_every_hit():
    reranked = rerank(lambda_mult=0.0)
    assert all(hit.prior_rank is not None for hit in reranked.hits)
    assert all(hit.prior_score is not None for hit in reranked.hits)


def test_prior_rank_is_the_pre_rerank_position():
    reranked = rerank(lambda_mult=0.0)
    by_key = {hit.chunk.id.removeprefix("chunk-"): hit for hit in reranked.hits}
    assert [by_key[k].prior_rank for k in ("a", "b", "c", "d")] == [1, 2, 3, 4]


def test_prior_score_is_the_pre_rerank_score():
    reranked = rerank(lambda_mult=0.0)
    for hit in reranked.hits:
        text = dict(CANDIDATES)[hit.chunk.id.removeprefix("chunk-")]
        assert hit.prior_score == pytest.approx(relevance(text))


def test_rank_is_renumbered_one_based_and_contiguous():
    reranked = rerank(lambda_mult=0.0)
    assert [hit.rank for hit in reranked.hits] == [1, 2, 3, 4]


def test_the_distinct_candidate_shows_real_rank_movement():
    reranked = rerank(lambda_mult=0.0)
    moved = next(h for h in reranked.hits if h.chunk.id == "chunk-d")
    assert (moved.prior_rank, moved.rank) == (4, 2)


def test_a_second_rerank_does_not_lose_the_original_position():
    """Rerankers stack; the second pass reports movement against the first."""
    once = rerank(lambda_mult=0.0)
    twice = rerank(once.model_dump(mode="json"), lambda_mult=1.0)
    assert keys(twice) == ["a", "b", "c", "d"]
    assert {h.chunk.id: h.prior_rank for h in twice.hits}["chunk-d"] == 2


# --------------------------------------------------------------------------
# top_k and edges
# --------------------------------------------------------------------------


def test_top_k_is_respected():
    reranked = rerank(lambda_mult=1.0, top_k=2)
    assert keys(reranked) == ["a", "b"]
    assert [hit.rank for hit in reranked.hits] == [1, 2]


def test_top_k_larger_than_the_candidate_set_returns_everything():
    assert len(rerank(top_k=50).hits) == len(CANDIDATES)


def test_empty_input_returns_empty_without_raising():
    reranked = rerank(result([]))
    assert reranked.hits == []


def test_a_single_hit_is_returned_unchanged():
    reranked = rerank(result([CANDIDATES[0]]))
    assert len(reranked.hits) == 1
    hit = reranked.hits[0]
    assert hit.chunk.id == "chunk-a"
    assert (hit.rank, hit.prior_rank) == (1, 1)


def test_the_result_envelope_survives():
    reranked = rerank()
    assert reranked.query_id == "q" * 16
    assert reranked.total_candidates == len(CANDIDATES)


def test_chunks_are_carried_through_untouched():
    reranked = rerank(lambda_mult=0.0)
    hit = next(h for h in reranked.hits if h.chunk.id == "chunk-d")
    assert hit.chunk.text == DISTINCT[1]
    assert hit.chunk.source_element_ids == ["el-d"]
    assert hit.retriever == "dense"


def test_embeds_the_augmented_text_not_the_cited_text():
    """`embed_text` is the contextual-retrieval seam and must win here too."""
    payload = result()
    # Give the unrelated passage an augmented form that is pure query text: it
    # is now the most relevant candidate even though its cited text is not.
    payload["hits"][3]["chunk"]["embed_text"] = QUERY_TEXT
    reranked = rerank(payload, lambda_mult=1.0)
    assert keys(reranked)[0] == "d"
    assert reranked.hits[0].chunk.text == DISTINCT[1]
