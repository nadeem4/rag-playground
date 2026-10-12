"""Retrieve wide, narrow later: a real retriever feeding a real MMR pass.

The retriever hands on a pool of 20; MMR picks 5 from it. If the retriever only
passed on 5, MMR could reorder them but never choose, and its output would be
the same five pieces as the retriever's top 5.
"""

from __future__ import annotations

from pathlib import Path

from pandion.artifacts import Artifact, ArtifactType
from pandion.payloads import Chunk, ChunkSet, Query, RetrievalResult
from pandion.plugins.index.lancedb_store import LanceDbIndex, LanceDbIndexConfig
from pandion.plugins.retrieve.dense import DenseConfig, DenseRetriever
from pandion.ports import RunContext
from pandion.storage import Store
from plugins.rerank.mmr import MmrRerank, MmrRerankConfig

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


def _ctx(root: Path) -> RunContext:
    ctx = RunContext(output_dir=root / "out", emit=lambda e: None, tmp=root / "tmp")
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    ctx.tmp.mkdir(parents=True, exist_ok=True)
    return ctx


def build_index(tmp_path: Path, *texts: str) -> Path:
    """Build an index with the fake embedder and return the committed folder."""
    chunks = [Chunk(id=f"c{i}", text=text, ordinal=i, doc_id="doc-1") for i, text in enumerate(texts)]
    chunk_set = ChunkSet(chunks=chunks, doc_id="doc-1", source_text=" ".join(texts))
    payload = LanceDbIndex().apply(
        {"chunks": [chunk_set.model_dump(mode="json")]},
        LanceDbIndexConfig(embedder="fake-deterministic"),
        _ctx(tmp_path / "index-scratch"),
    )
    store = Store(tmp_path / "store")
    store.put(Artifact(id="a" * 64, type=ArtifactType.INDEX), payload)
    return store.load("a" * 64, ArtifactType.INDEX)


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
