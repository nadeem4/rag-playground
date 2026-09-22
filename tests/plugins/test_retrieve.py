"""Contract tests for the three retrieve plugins.

Every test builds a *real* LanceDB index through the real index transform and
the real store, then hands the retriever the `Path` the store gives back. That
is what the executor does, and it is the only way the load-bearing property
here can be tested at all: the retriever learns which embedder and which
dimensionality to query with by reading `descriptor.json` out of the committed
index, never from its own config.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.artifacts import Artifact, ArtifactType
from core.payloads import Chunk, ChunkSet, Query, RetrievalResult
from core.ports import RunContext, Stage
from core.storage import Store
from plugins.index.lancedb_store import DESCRIPTOR, LanceDbIndex, LanceDbIndexConfig
from plugins.retrieve import _base
from plugins.retrieve.bm25 import Bm25Config, Bm25Retriever
from plugins.retrieve.dense import DenseConfig, DenseRetriever
from plugins.retrieve.hybrid_rrf import HybridRrfConfig, HybridRrfRetriever
from providers.embeddings import FakeDeterministicEmbedder

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

CORPUS = [
    "Paris is the capital of France",
    "Bananas are a yellow tropical fruit",
    "The mitochondrion is the powerhouse of the cell",
]


def build_index(tmp_path: Path, *texts: str, embed_texts=None, **config) -> Path:
    """Build an index the way the executor does and return the committed dir."""
    chunks = [
        Chunk(
            id=f"c{i}",
            text=text,
            embed_text=None if embed_texts is None else embed_texts[i],
            ordinal=i,
            doc_id="doc-1",
        )
        for i, text in enumerate(texts)
    ]
    payload_in = ChunkSet(
        chunks=chunks, doc_id="doc-1", source_text=" ".join(texts)
    ).model_dump(mode="json")

    store = Store(tmp_path / "store")
    ctx = _ctx(tmp_path / "index-scratch")
    config = {"embedder": "fake-deterministic"} | config
    payload = LanceDbIndex().apply(
        {"chunks": [payload_in]}, LanceDbIndexConfig(**config), ctx
    )

    aid = "a" * 64
    store.put(Artifact(id=aid, type=ArtifactType.INDEX), payload)
    loaded = store.load(aid, ArtifactType.INDEX)
    assert isinstance(loaded, Path)
    return loaded


def _ctx(root: Path) -> RunContext:
    ctx = RunContext(
        output_dir=root / "out", emit=lambda e: None, tmp=root / "tmp"
    )
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    ctx.tmp.mkdir(parents=True, exist_ok=True)
    return ctx


def retrieve(transform, index_dir: Path, query: Query, tmp_path: Path, **config):
    """Run a retriever and validate its payload back into a `RetrievalResult`."""
    cfg = transform.config_model(**config)
    ctx = _ctx(tmp_path / f"retrieve-scratch-{transform.name}")
    payload = transform.apply(
        {"index": index_dir, "query": query.model_dump(mode="json")}, cfg, ctx
    )
    assert isinstance(payload, dict), "the payload must be JSON-serializable"
    return RetrievalResult.model_validate(payload)


def texts(result: RetrievalResult) -> list[str]:
    return [hit.chunk.text for hit in result.hits]


def patch_descriptor(index_dir: Path, **fields) -> None:
    path = index_dir / DESCRIPTOR
    desc = json.loads(path.read_text(encoding="utf-8"))
    desc.update(fields)
    path.write_text(json.dumps(desc), encoding="utf-8")


ALL = [DenseRetriever(), Bm25Retriever(), HybridRrfRetriever()]
ALL_IDS = [t.name for t in ALL]


# --------------------------------------------------------------------------
# dense
# --------------------------------------------------------------------------


def test_dense_returns_the_semantically_closest_chunk(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        DenseRetriever(),
        index_dir,
        Query(text="what is the capital of France"),
        tmp_path,
        top_k=1,
    )

    assert texts(result) == ["Paris is the capital of France"]


def test_dense_hits_are_rank_ordered(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        DenseRetriever(), index_dir, Query(text="capital of France"), tmp_path
    )

    assert [hit.rank for hit in result.hits] == [1, 2, 3]
    scores = [hit.score for hit in result.hits]
    assert scores == sorted(scores, reverse=True)


def test_dense_populates_hit_provenance(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    hit = retrieve(
        DenseRetriever(),
        index_dir,
        Query(text="capital of France"),
        tmp_path,
        top_k=1,
    ).hits[0]

    assert hit.retriever == "dense"
    assert hit.matched_chunk_id == hit.chunk.id == "c0"


def test_the_cited_chunk_keeps_its_original_text(tmp_path):
    """Retrieval happens on `text_to_embed`; the citation must be `chunk.text`."""
    index_dir = build_index(
        tmp_path,
        "It was 4.2 billion.",
        embed_texts=["Acme Corp Q3 revenue: it was 4.2 billion."],
    )

    hit = retrieve(
        DenseRetriever(), index_dir, Query(text="Acme Corp revenue"), tmp_path
    ).hits[0]

    assert hit.chunk.text == "It was 4.2 billion."
    assert hit.chunk.embed_text == "Acme Corp Q3 revenue: it was 4.2 billion."


def test_embed_text_is_the_hyde_seam(tmp_path):
    """`query.embed_text` — not `query.text` — decides what is retrieved on."""
    index_dir = build_index(tmp_path, *CORPUS)

    plain = retrieve(
        DenseRetriever(), index_dir, Query(text="bananas"), tmp_path, top_k=1
    )
    hyde = retrieve(
        DenseRetriever(),
        index_dir,
        Query(text="bananas", embed_text="the mitochondrion powerhouse of the cell"),
        tmp_path,
        top_k=1,
    )

    assert texts(plain) == ["Bananas are a yellow tropical fruit"]
    assert texts(hyde) == ["The mitochondrion is the powerhouse of the cell"]


# --------------------------------------------------------------------------
# bm25
# --------------------------------------------------------------------------


def test_bm25_returns_lexical_matches(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(Bm25Retriever(), index_dir, Query(text="bananas"), tmp_path)

    assert texts(result) == ["Bananas are a yellow tropical fruit"]
    assert result.hits[0].retriever == "bm25"
    assert result.hits[0].score > 0


def test_bm25_against_a_dense_only_index_fails_with_an_actionable_message(tmp_path):
    """`provides` is a static class claim; `descriptor['backends']` is the truth."""
    index_dir = build_index(tmp_path, *CORPUS, build_fts=False)

    with pytest.raises(ValueError) as excinfo:
        retrieve(Bm25Retriever(), index_dir, Query(text="bananas"), tmp_path)

    message = str(excinfo.value)
    assert "fts" in message
    assert "bm25" in message
    assert "build_fts" in message


def test_hybrid_against_a_dense_only_index_fails_too(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS, build_fts=False)

    with pytest.raises(ValueError, match="fts"):
        retrieve(HybridRrfRetriever(), index_dir, Query(text="bananas"), tmp_path)


# --------------------------------------------------------------------------
# hybrid rrf
# --------------------------------------------------------------------------


def test_hybrid_fuses_both_rankings(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        HybridRrfRetriever(), index_dir, Query(text="bananas"), tmp_path
    )

    assert texts(result)[0] == "Bananas are a yellow tropical fruit"
    assert [hit.rank for hit in result.hits] == list(
        range(1, len(result.hits) + 1)
    )
    assert all(hit.retriever == "hybrid_rrf" for hit in result.hits)
    # Dense returns the whole corpus; bm25 returns only the lexical match, so
    # fusion must have seen more candidates than either list alone would give.
    assert len(result.hits) == 3


def test_hybrid_populates_both_component_scores(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        HybridRrfRetriever(), index_dir, Query(text="bananas"), tmp_path
    )
    top = result.hits[0]

    assert set(top.component_scores) == {"dense", "bm25"}
    assert top.component_scores["bm25"] > 0
    # A document no lexical list returned carries no bm25 component — absence is
    # not a zero score.
    assert all(
        "dense" in hit.component_scores for hit in result.hits
    )
    assert any("bm25" not in hit.component_scores for hit in result.hits[1:])


def test_rrf_score_follows_the_formula(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        HybridRrfRetriever(),
        index_dir,
        Query(text="bananas"),
        tmp_path,
        rrf_k=60,
    )

    # Rank 1 in dense and rank 1 in bm25.
    assert result.hits[0].score == pytest.approx(2 / 61)


def test_rrf_k_changes_the_fusion(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)
    query = Query(text="bananas")

    low = retrieve(
        HybridRrfRetriever(), index_dir, query, tmp_path, rrf_k=1
    ).hits[0]

    assert low.score == pytest.approx(2 / 2)


# --------------------------------------------------------------------------
# the load-bearing rule: the index says which embedder and which width
# --------------------------------------------------------------------------


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_no_config_field_names_an_embedder(transform):
    """The retriever must have no way to disagree with the index about vectors."""
    assert set(transform.config_model.model_fields) <= {"top_k", "rrf_k"}


def test_the_query_vector_uses_the_indexed_dimensionality(tmp_path, monkeypatch):
    """Build at 64 dims; the query must be embedded at 64 dims, not 384."""
    index_dir = build_index(tmp_path, *CORPUS, truncate_dim=64)

    seen: list[tuple[int | None, int]] = []
    original = _base.embed_cached

    def spy(provider, texts_, *, kind, dim):
        out = original(provider, texts_, kind=kind, dim=dim)
        seen.append((dim, len(out[0][0])))
        return out

    # Installed *after* the build, so only the query embedding is captured.
    monkeypatch.setattr(_base, "embed_cached", spy)

    retrieve(
        DenseRetriever(), index_dir, Query(text="capital of France"), tmp_path
    )

    assert seen == [(64, 64)]


# --------------------------------------------------------------------------
# the query embedding rule (I-4): which text, and which kind
# --------------------------------------------------------------------------


class KindRecorder(FakeDeterministicEmbedder):
    """The fake, recording `(text, kind)` for every text that reaches it."""

    name = "kind-recorder"
    model_id = "kind-recorder"
    calls: list[tuple[str, str]] = []

    def _embed(self, texts, kind):
        KindRecorder.calls.extend((t, kind) for t in texts)
        return super()._embed(texts, kind)


@pytest.fixture
def recorder_index(tmp_path, monkeypatch) -> Path:
    """An index whose descriptor names the recording embedder."""
    from providers import embeddings

    monkeypatch.setitem(embeddings._EMBEDDERS, KindRecorder.name, KindRecorder)
    index_dir = build_index(tmp_path, *CORPUS)
    patch_descriptor(index_dir, embedding_model=KindRecorder.name)
    KindRecorder.calls = []
    return index_dir


@pytest.mark.parametrize("transform", [DenseRetriever(), HybridRrfRetriever()], ids=["dense", "hybrid_rrf"])
def test_a_plain_query_is_embedded_as_a_query(tmp_path, recorder_index, transform):
    retrieve(transform, recorder_index, Query(text="capital of France"), tmp_path)
    assert KindRecorder.calls == [("capital of France", "query")]


@pytest.mark.parametrize("transform", [DenseRetriever(), HybridRrfRetriever()], ids=["dense", "hybrid_rrf"])
def test_a_hyde_document_is_embedded_as_a_document(tmp_path, recorder_index, transform):
    """`embed_text` is a hypothetical passage, so no query instruction."""
    retrieve(
        transform,
        recorder_index,
        Query(text="bananas", embed_text="Bananas are a yellow fruit."),
        tmp_path,
    )
    assert KindRecorder.calls == [("Bananas are a yellow fruit.", "document")]


def test_bm25_always_searches_the_question_text(tmp_path, recorder_index):
    """Lexical search ignores `embed_text` and never embeds anything."""
    result = retrieve(
        Bm25Retriever(),
        recorder_index,
        Query(text="bananas", embed_text="the mitochondrion powerhouse"),
        tmp_path,
    )
    assert texts(result) == ["Bananas are a yellow tropical fruit"]
    assert KindRecorder.calls == []


def test_the_rule_itself():
    assert _base.query_embedding_input(Query(text="q")) == ("q", "query")
    assert _base.query_embedding_input(Query(text="q", embed_text="d")) == (
        "d",
        "document",
    )


def test_a_truncated_index_still_retrieves_the_right_chunk(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS, truncate_dim=64)

    result = retrieve(
        DenseRetriever(),
        index_dir,
        Query(text="what is the capital of France"),
        tmp_path,
        top_k=1,
    )

    assert texts(result) == ["Paris is the capital of France"]


def test_an_unknown_embedder_in_the_descriptor_is_reported(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)
    patch_descriptor(index_dir, embedding_model="not-installed")

    with pytest.raises(KeyError, match="not-installed"):
        retrieve(
            DenseRetriever(), index_dir, Query(text="capital"), tmp_path
        )


def test_an_embedder_revision_mismatch_is_refused(tmp_path):
    """Same model name, different revision: the vectors are not comparable."""
    index_dir = build_index(tmp_path, *CORPUS)
    patch_descriptor(index_dir, embedding_revision="99")

    with pytest.raises(ValueError) as excinfo:
        retrieve(DenseRetriever(), index_dir, Query(text="capital"), tmp_path)

    assert "revision" in str(excinfo.value)
    assert "99" in str(excinfo.value)


def test_the_l2_index_is_queried_with_l2(tmp_path):
    """The metric is a property of the index, so it too comes from the descriptor."""
    index_dir = build_index(tmp_path, *CORPUS, metric="l2")

    result = retrieve(
        DenseRetriever(),
        index_dir,
        Query(text="what is the capital of France"),
        tmp_path,
        top_k=1,
    )

    assert texts(result) == ["Paris is the capital of France"]


# --------------------------------------------------------------------------
# result shape, k handling, empty index
# --------------------------------------------------------------------------


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_top_k_is_respected(tmp_path, transform):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        transform, index_dir, Query(text="capital France bananas cell"), tmp_path, top_k=2
    )

    assert len(result.hits) == 2
    assert [hit.rank for hit in result.hits] == [1, 2]


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_an_empty_index_returns_an_empty_result(tmp_path, transform):
    index_dir = build_index(tmp_path)

    result = retrieve(transform, index_dir, Query(text="anything"), tmp_path)

    assert result.hits == []
    assert result.total_candidates == 0


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_an_empty_query_returns_an_empty_result(tmp_path, transform):
    """A query node with nothing typed into it yet is not an error."""
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(transform, index_dir, Query(text=""), tmp_path)

    assert result.hits == []


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_the_result_carries_its_metadata(tmp_path, transform):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        transform,
        index_dir,
        Query(text="capital of France"),
        tmp_path,
        top_k=1,
    )

    # `fetch_k` in the payload is how deep each search went: the pool size.
    assert result.fetch_k == 1
    assert result.total_candidates >= 1
    assert result.total_candidates >= len(result.hits)
    assert result.timings_ms and all(v >= 0 for v in result.timings_ms.values())
    assert len(result.query_id) == 16


def test_the_query_id_is_stable_and_query_dependent(tmp_path):
    index_dir = build_index(tmp_path, *CORPUS)

    def qid(text: str) -> str:
        return retrieve(
            DenseRetriever(), index_dir, Query(text=text), tmp_path
        ).query_id

    assert qid("capital of France") == qid("capital of France")
    assert qid("capital of France") != qid("bananas")


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_a_pool_larger_than_the_index_returns_every_row(tmp_path, transform):
    index_dir = build_index(tmp_path, *CORPUS)

    result = retrieve(
        transform,
        index_dir,
        Query(text="capital France bananas cell"),
        tmp_path,
        top_k=10,
    )

    assert len(result.hits) == len(CORPUS)


#: Enough distinct passages that every search has more than 20 rows to rank.
WIDE_CORPUS = [f"Passage {i} mentions the capital of France and bananas" for i in range(30)]


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_by_default_a_retriever_hands_on_a_pool_of_20(tmp_path, transform):
    """Retrieve wide, narrow later: the reranker or use case picks from 20."""
    index_dir = build_index(tmp_path, *WIDE_CORPUS)

    result = retrieve(
        transform, index_dir, Query(text="capital of France bananas"), tmp_path
    )

    assert len(result.hits) == 20
    assert [hit.rank for hit in result.hits] == list(range(1, 21))
    assert result.total_candidates >= 20


# --------------------------------------------------------------------------
# registration and declared contract
# --------------------------------------------------------------------------


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_registered_under_the_retrieve_stage(transform):
    from core.registry import registry

    cls = type(transform)
    assert registry.get(Stage.RETRIEVE, cls.name) is cls
    assert cls.output == ArtifactType.RETRIEVAL_RESULT
    assert cls.inputs["index"].type == ArtifactType.INDEX
    assert cls.inputs["query"].type == ArtifactType.QUERY
    assert cls.inputs["query"].ambient
    assert not cls.inputs["index"].ambient


def test_each_retriever_declares_the_backends_it_needs():
    assert DenseRetriever.requires == {"index": {"backends": ["dense"]}}
    assert Bm25Retriever.requires == {"index": {"backends": ["fts"]}}
    assert HybridRrfRetriever.requires == {"index": {"backends": ["dense", "fts"]}}


def test_config_defaults_match_the_plan():
    assert DenseConfig().top_k == 20
    assert Bm25Config().top_k == 20
    assert (HybridRrfConfig().top_k, HybridRrfConfig().rrf_k) == (20, 60)


@pytest.mark.parametrize("transform", ALL, ids=ALL_IDS)
def test_explain_describes_a_pool_for_the_next_step(transform):
    exp = transform.explain(transform.config_model())
    assert "20" in exp.settings
    assert "pool" in exp.settings.lower()
    assert "top 5" not in exp.settings
