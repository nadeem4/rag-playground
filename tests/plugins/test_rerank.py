"""Contract tests for the MMR reranker.

Relevance is recomputed in the embedder's space, so the fixtures pin the numbers
they depend on rather than assuming them: `test_the_fixture_is_strictly_ordered`
fails loudly if the fake embedder ever changes and quietly invalidates the
ordering the rest of the file asserts on.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.artifacts import ArtifactType
from core.payloads import Chunk, Hit, Query, RetrievalResult
from core.ports import Stage
from core.registry import registry
from plugins.index.lancedb_store import DESCRIPTOR
from plugins.rerank.mmr import MmrRerank, MmrRerankConfig
from providers.embeddings import FakeDeterministicEmbedder, get_embedder

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


def write_index(directory: Path, **descriptor) -> Path:
    """An index directory as far as MMR reads one: its `descriptor.json`.

    MMR never searches the table, it only needs to know which embedder and
    which width the hits were retrieved in.
    """
    directory.mkdir(parents=True, exist_ok=True)
    desc = {
        "backends": ["dense", "fts"],
        "native_dim": 384,
        "dim": 384,
        "metric": "cosine",
        "embedding_model": "fake-deterministic",
        "embedding_revision": "1",
        "vector_kind": "dense",
        "doc_count": 0,
        "embeddings_computed": 0,
        "embeddings_cached": 0,
    } | descriptor
    (directory / DESCRIPTOR).write_text(json.dumps(desc), encoding="utf-8")
    return directory


#: Set per test by `_index`; the fake embedder at native width by default.
INDEX: dict[str, Path] = {}


@pytest.fixture(autouse=True)
def _index(tmp_path):
    INDEX["dir"] = write_index(tmp_path / "index")


def rerank(
    payload: dict | None = None,
    query: str | Query = QUERY_TEXT,
    index: Path | None = None,
    **config,
) -> RetrievalResult:
    payload = result() if payload is None else payload
    q = query if isinstance(query, Query) else Query(text=query)
    out = MmrRerank().apply(
        {
            "result": payload,
            "query": q.model_dump(mode="json"),
            "index": index or INDEX["dir"],
        },
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


def test_declares_a_result_port_and_ambient_query_and_index_ports():
    assert MmrRerank.output is ArtifactType.RETRIEVAL_RESULT
    assert set(MmrRerank.inputs) == {"result", "query", "index"}
    assert MmrRerank.inputs["result"].type is ArtifactType.RETRIEVAL_RESULT
    assert MmrRerank.inputs["result"].ambient is False
    assert MmrRerank.inputs["query"].type is ArtifactType.QUERY
    assert MmrRerank.inputs["query"].ambient is True
    assert MmrRerank.inputs["index"].type is ArtifactType.INDEX
    assert MmrRerank.inputs["index"].ambient is True


def test_config_defaults():
    cfg = MmrRerankConfig()
    assert cfg.lambda_mult == 0.5
    assert cfg.top_k == 5


def test_config_has_no_embedder_field():
    """The index says which model; MMR has no way to say a different one."""
    assert set(MmrRerankConfig.model_fields) == {"lambda_mult", "top_k"}


# --------------------------------------------------------------------------
# the embedder and width come from the index descriptor
# --------------------------------------------------------------------------


class KindRecorder(FakeDeterministicEmbedder):
    name = "mmr-kind-recorder"
    model_id = "mmr-kind-recorder"
    calls: list[tuple[str, str]] = []

    def _embed(self, texts, kind):
        KindRecorder.calls.extend((t, kind) for t in texts)
        return super()._embed(texts, kind)


@pytest.fixture
def recorder(monkeypatch, tmp_path) -> Path:
    from providers import embeddings

    monkeypatch.setitem(embeddings._EMBEDDERS, KindRecorder.name, KindRecorder)
    KindRecorder.calls = []
    return write_index(tmp_path / "rec-index", embedding_model=KindRecorder.name)


def test_mmr_embeds_with_the_index_embedder(recorder):
    rerank(index=recorder)
    embedded = {text for text, _ in KindRecorder.calls}
    assert embedded == {text for _, text in CANDIDATES} | {QUERY_TEXT}


def test_mmr_embeds_hits_as_documents_and_the_question_as_a_query(recorder):
    rerank(index=recorder)
    kinds = dict(KindRecorder.calls)
    assert kinds[QUERY_TEXT] == "query"
    assert all(kinds[text] == "document" for _, text in CANDIDATES)


def test_mmr_embeds_a_hyde_document_as_a_document(recorder):
    rerank(query=Query(text=QUERY_TEXT, embed_text="Paris is in France."), index=recorder)
    kinds = dict(KindRecorder.calls)
    assert kinds["Paris is in France."] == "document"
    assert QUERY_TEXT not in kinds


def test_mmr_works_at_the_index_truncated_width(tmp_path, monkeypatch):
    seen: list[int | None] = []
    import plugins.rerank.mmr as mmr

    original = mmr.embed_cached

    def spy(provider, texts_, *, kind, dim):
        seen.append(dim)
        return original(provider, texts_, kind=kind, dim=dim)

    monkeypatch.setattr(mmr, "embed_cached", spy)
    reranked = rerank(index=write_index(tmp_path / "ix64", dim=64), lambda_mult=1.0)

    assert seen == [64, 64]
    assert keys(reranked) == ["a", "b", "c", "d"]


def test_mmr_refuses_a_revision_mismatch(tmp_path):
    with pytest.raises(ValueError, match="revision"):
        rerank(index=write_index(tmp_path / "old", embedding_revision="0"))


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


# --------------------------------------------------------------------------
# retrieve wide, narrow later
# --------------------------------------------------------------------------


def test_the_result_counts_the_pool_mmr_chose_from():
    """"2 results from 4 candidates": the candidates are what MMR received."""
    payload = result()
    payload["total_candidates"] = 99  # the retriever's own count, overwritten

    reranked = rerank(payload, top_k=2)

    assert len(reranked.hits) == 2
    assert reranked.total_candidates == len(CANDIDATES)


def test_explain_says_it_picks_top_k_from_the_pool():
    exp = MmrRerank().explain(MmrRerankConfig(top_k=3))
    assert "3" in exp.settings
    assert "pool" in exp.settings.lower()
    # The old wording described the bug: the retriever passing on only top_k.
    assert "give the retriever a top_k" not in (exp.tradeoff or "")
