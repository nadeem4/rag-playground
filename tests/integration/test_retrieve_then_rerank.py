"""Retrieve wide, narrow later: a real retriever feeding a real MMR pass.

The retriever hands on a pool of 20; MMR picks 5 from it. If the retriever only
passed on 5, MMR could reorder them but never choose, and its output would be
the same five pieces as the retriever's top 5.
"""

from __future__ import annotations

from core.payloads import Query, RetrievalResult
from plugins.rerank.mmr import MmrRerank, MmrRerankConfig
from plugins.retrieve.dense import DenseConfig, DenseRetriever
from tests.plugins.test_retrieve import _ctx, build_index

QUESTION = "What is the capital of France?"

#: Many near-duplicates of the best answer crowd the top of a dense ranking;
#: the other passages are less relevant but say something different.
CORPUS = [
    *(f"The capital of France is Paris, note {i}." for i in range(12)),
    *(
        f"France has many regions, and region {i} grows grapes for wine."
        for i in range(12)
    ),
]


def test_mmr_chooses_5_from_a_pool_of_20(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)
    query = Query(text=QUESTION).model_dump(mode="json")

    pool = DenseRetriever().apply(
        {"index": index_dir, "query": query},
        DenseConfig(),
        _ctx(tmp_path / "retrieve"),
    )
    reranked = RetrievalResult.model_validate(
        MmrRerank().apply(
            {"result": pool, "query": query, "index": index_dir},
            MmrRerankConfig(top_k=5, lambda_mult=0.3),
            None,
        )
    )

    pool_ids = [hit["chunk"]["id"] for hit in pool["hits"]]
    picked = [hit.chunk.id for hit in reranked.hits]

    assert len(pool_ids) == 20, "MMR's input is the retriever's pool of 20"
    assert len(picked) == 5
    assert reranked.total_candidates == 20
    assert set(picked) <= set(pool_ids)
    assert set(picked) != set(pool_ids[:5]), "MMR chose, not just reordered"
