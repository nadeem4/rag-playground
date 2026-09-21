"""Contract tests for the LanceDB index plugin.

Everything here goes through the *store*, never through the writer callable
directly. That is deliberate: the executor puts the payload and then reads it
back, so a retriever always receives a `Path`, never the callable. A test that
called the callable itself would pass while the real pipeline broke.
"""

from __future__ import annotations

import json
from pathlib import Path

import lancedb
import pytest

from core.artifacts import Artifact, ArtifactType
from core.payloads import Chunk, ChunkSet
from core.ports import RunContext
from core.storage import Store
from plugins.index.lancedb_store import (
    DESCRIPTOR,
    TABLE,
    LanceDbIndex,
    LanceDbIndexConfig,
)
from providers.embeddings import get_embedder


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def chunk_set(*texts: str, doc_id: str = "doc-1", embed_texts=None) -> dict:
    """A chunk set as the executor delivers it: a plain JSON dict."""
    chunks = [
        Chunk(
            id=f"{doc_id}-{i}",
            text=text,
            embed_text=None if embed_texts is None else embed_texts[i],
            ordinal=i,
            doc_id=doc_id,
        )
        for i, text in enumerate(texts)
    ]
    return ChunkSet(
        chunks=chunks, doc_id=doc_id, source_text=" ".join(texts)
    ).model_dump(mode="json")


def build(tmp_path: Path, *sets: dict, **config) -> tuple[Path, RunContext, Store]:
    """Run the transform the way the executor does, and read the payload back.

    Returns the *directory* the store hands downstream, so every assertion is
    made against what a retriever will really see.
    """
    store = Store(tmp_path / "store")
    tf = LanceDbIndex()
    # The fake unless a test says otherwise: the default is a real model, and
    # the fast suite never downloads one.
    cfg = LanceDbIndexConfig(**({"embedder": "fake-deterministic"} | config))
    ctx = RunContext(
        output_dir=tmp_path / "scratch" / "out",
        emit=lambda e: None,
        tmp=tmp_path / "scratch" / "tmp",
    )
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    ctx.tmp.mkdir(parents=True, exist_ok=True)

    payload = tf.apply({"chunks": list(sets)}, cfg, ctx)
    assert callable(payload), (
        "an index payload must be a callable taking the destination directory — "
        "that is what DirectorySerializer.write expects"
    )

    aid = "a" * 64
    store.put(Artifact(id=aid, type=ArtifactType.INDEX), payload)
    loaded = store.load(aid, ArtifactType.INDEX)
    assert isinstance(loaded, Path)
    return loaded, ctx, store


def descriptor_of(index_dir: Path) -> dict:
    return json.loads((index_dir / DESCRIPTOR).read_text(encoding="utf-8"))


def open_table(index_dir: Path):
    return lancedb.connect(index_dir).open_table(TABLE)


# --------------------------------------------------------------------------
# the index builds and is queryable
# --------------------------------------------------------------------------


def test_dense_search_finds_the_matching_chunk(tmp_path):
    index_dir, _, _ = build(
        tmp_path,
        chunk_set(
            "Paris is the capital of France",
            "Bananas are a yellow tropical fruit",
            "The mitochondrion is the powerhouse of the cell",
        ),
    )
    embedder = get_embedder("fake-deterministic")
    vector = embedder.embed(["what is the capital of France"])[0]

    hits = open_table(index_dir).search(vector).limit(1).to_list()

    assert hits[0]["text"] == "Paris is the capital of France"


def test_fts_index_exists_and_returns_matches(tmp_path):
    index_dir, _, _ = build(
        tmp_path,
        chunk_set(
            "Paris is the capital of France",
            "Bananas are a yellow tropical fruit",
        ),
    )
    table = open_table(index_dir)

    assert any("text" in idx.columns for idx in table.list_indices())

    hits = table.search("bananas", query_type="fts").limit(5).to_list()
    assert [h["text"] for h in hits] == ["Bananas are a yellow tropical fruit"]


def test_build_fts_false_leaves_no_text_index(tmp_path):
    index_dir, _, _ = build(
        tmp_path, chunk_set("Paris is the capital of France"), build_fts=False
    )
    table = open_table(index_dir)

    assert not any("text" in idx.columns for idx in table.list_indices())
    assert descriptor_of(index_dir)["backends"] == ["dense"]


def test_empty_chunk_set_does_not_crash(tmp_path):
    index_dir, _, _ = build(tmp_path, chunk_set())

    assert open_table(index_dir).count_rows() == 0
    assert descriptor_of(index_dir)["doc_count"] == 0


def test_no_chunk_sets_at_all_does_not_crash(tmp_path):
    index_dir, _, _ = build(tmp_path)

    assert open_table(index_dir).count_rows() == 0


def test_artifact_directory_survives_a_store_round_trip_and_reopens(tmp_path):
    """The store *moves* the built directory into place. Reopening it after that
    move is the whole point of the directory payload — and the place a Windows
    file lock would show up."""
    index_dir, ctx, store = build(
        tmp_path, chunk_set("Paris is the capital of France")
    )

    assert index_dir.is_dir()
    assert index_dir != ctx.output_dir
    assert str(index_dir).startswith(str(store.root))
    assert open_table(index_dir).count_rows() == 1

    # Reopening a second time must also work: nothing may hold an exclusive
    # handle on the committed artifact.
    assert open_table(index_dir).count_rows() == 1


# --------------------------------------------------------------------------
# the contextual-retrieval seam
# --------------------------------------------------------------------------


def test_embeds_text_to_embed_and_never_text(tmp_path):
    index_dir, _, _ = build(
        tmp_path,
        chunk_set(
            "It was 4.2 billion.",
            embed_texts=["Acme Corp Q3 revenue: it was 4.2 billion."],
        ),
    )
    embedder = get_embedder("fake-deterministic")
    row = open_table(index_dir).to_arrow().to_pylist()[0]

    expected = embedder.embed(["Acme Corp Q3 revenue: it was 4.2 billion."])[0]
    wrong = embedder.embed(["It was 4.2 billion."])[0]

    assert row["vector"] == pytest.approx(expected, abs=1e-6)
    assert row["vector"] != pytest.approx(wrong, abs=1e-6)


def test_the_displayed_chunk_keeps_its_original_text(tmp_path):
    """`text_to_embed` is what is retrieved on; `chunk.text` is what is cited.
    Augmenting the first must never corrupt the second."""
    index_dir, _, _ = build(
        tmp_path,
        chunk_set(
            "It was 4.2 billion.",
            embed_texts=["Acme Corp Q3 revenue: it was 4.2 billion."],
        ),
    )
    row = open_table(index_dir).to_arrow().to_pylist()[0]

    assert Chunk(**json.loads(row["chunk_json"])).text == "It was 4.2 billion."


# --------------------------------------------------------------------------
# variadic port = corpus
# --------------------------------------------------------------------------


def test_multiple_chunk_sets_are_concatenated(tmp_path):
    index_dir, _, _ = build(
        tmp_path,
        chunk_set("Paris is the capital of France", doc_id="doc-a"),
        chunk_set("Rome", "Berlin", doc_id="doc-b"),
    )
    table = open_table(index_dir)

    assert table.count_rows() == 3
    assert descriptor_of(index_dir)["doc_count"] == 3
    assert {r["doc_id"] for r in table.to_arrow().to_pylist()} == {"doc-a", "doc-b"}


# --------------------------------------------------------------------------
# the capability descriptor
# --------------------------------------------------------------------------

DESCRIPTOR_KEYS = {
    "backends",
    "native_dim",
    "dim",
    "metric",
    "embedding_model",
    "embedding_revision",
    "vector_kind",
    "doc_count",
    "embeddings_computed",
    "embeddings_cached",
}


def test_descriptor_carries_every_capability_field(tmp_path):
    index_dir, _, _ = build(
        tmp_path, chunk_set("Paris is the capital of France"), metric="l2"
    )
    desc = descriptor_of(index_dir)

    assert DESCRIPTOR_KEYS <= set(desc)
    assert desc == {
        "backends": ["dense", "fts"],
        "native_dim": 384,
        "dim": 384,
        "metric": "l2",
        "embedding_model": "fake-deterministic",
        "embedding_revision": "1",
        "vector_kind": "dense",
        "doc_count": 1,
        "embeddings_computed": 1,
        "embeddings_cached": 0,
    }


def test_descriptor_reports_the_truncated_dim(tmp_path):
    index_dir, _, _ = build(
        tmp_path, chunk_set("Paris is the capital of France"), truncate_dim=64
    )
    desc = descriptor_of(index_dir)

    assert (desc["native_dim"], desc["dim"]) == (384, 64)
    assert len(open_table(index_dir).to_arrow().to_pylist()[0]["vector"]) == 64


def test_descriptor_is_offered_as_artifact_meta(tmp_path):
    """The executor builds the Artifact, so a transform cannot set meta directly.
    The descriptor is published on `ctx.extras['meta']` — the proposed core
    convention — as well as into the directory, which is the only channel a
    downstream retriever can actually read."""
    _, ctx, _ = build(tmp_path, chunk_set("Paris is the capital of France"))

    assert DESCRIPTOR_KEYS <= set(ctx.extras["meta"]["index_descriptor"])


def test_descriptor_counts_computed_and_cached_embeddings(tmp_path):
    """A truncate_dim sweep over one corpus embeds each chunk once."""
    texts = ("Paris is the capital of France", "Bananas are yellow", "Cells")
    counts = []
    for n, dim in enumerate((None, 256, 64)):
        index_dir, _, _ = build(tmp_path / str(n), chunk_set(*texts), truncate_dim=dim)
        desc = descriptor_of(index_dir)
        counts.append((desc["embeddings_computed"], desc["embeddings_cached"]))

    assert counts == [(3, 0), (0, 3), (0, 3)]


def test_truncated_index_from_cache_matches_a_fresh_one(tmp_path, monkeypatch):
    texts = ("Paris is the capital of France", "Bananas are yellow")
    build(tmp_path / "warm", chunk_set(*texts))  # native width into the cache
    cached_dir, _, _ = build(tmp_path / "cached", chunk_set(*texts), truncate_dim=64)

    monkeypatch.setenv("RAG_PLAYGROUND_EMBED_CACHE", str(tmp_path / "cold-cache"))
    fresh_dir, _, _ = build(tmp_path / "fresh", chunk_set(*texts), truncate_dim=64)

    assert descriptor_of(cached_dir)["embeddings_computed"] == 0
    assert descriptor_of(fresh_dir)["embeddings_computed"] == 2
    rows = lambda d: [r["vector"] for r in open_table(d).to_arrow().to_pylist()]  # noqa: E731
    assert rows(cached_dir) == rows(fresh_dir)


# --------------------------------------------------------------------------
# config: the embedder and truncate_dim
# --------------------------------------------------------------------------


def test_the_default_embedder_is_qwen3():
    assert LanceDbIndexConfig().embedder == "qwen3-embedding-0.6b"


def test_the_embedder_is_a_choice_of_registered_names():
    from pydantic import ValidationError

    schema = LanceDbIndexConfig.model_json_schema()["properties"]["embedder"]
    assert set(schema["enum"]) == {
        "qwen3-embedding-0.6b",
        "bge-small-en-v1.5",
        "fake-deterministic",
    }
    with pytest.raises(ValidationError):
        LanceDbIndexConfig(embedder="text-embedding-3-large")


def test_truncate_dim_above_native_fails_readably(tmp_path):
    with pytest.raises(ValueError, match="at most 384"):
        build(tmp_path, chunk_set("Paris"), truncate_dim=512)


def test_truncate_dim_on_a_non_matryoshka_embedder_fails_before_loading(tmp_path):
    """bge is not matryoshka: refused with the reason, and no model download.

    The autouse guard in `tests/conftest.py` fails any model load here, so
    reaching the error proves validation came first.
    """
    with pytest.raises(ValueError, match="bge-small-en-v1.5.*truncate_dim"):
        build(
            tmp_path,
            chunk_set("Paris"),
            embedder="bge-small-en-v1.5",
            truncate_dim=128,
        )


# --------------------------------------------------------------------------
# fingerprint
# --------------------------------------------------------------------------


def test_fingerprint_is_stable_for_the_same_config():
    cfg = LanceDbIndexConfig()
    assert LanceDbIndex().fingerprint(cfg) == LanceDbIndex().fingerprint(cfg)


def test_fingerprint_changes_with_the_embedder_revision(monkeypatch):
    tf = LanceDbIndex()
    cfg = LanceDbIndexConfig(embedder="fake-deterministic")
    before = tf.fingerprint(cfg)

    from providers.embeddings import FakeDeterministicEmbedder

    monkeypatch.setattr(FakeDeterministicEmbedder, "revision", "2")
    assert tf.fingerprint(cfg) != before


def test_fingerprint_changes_with_truncate_dim():
    tf = LanceDbIndex()
    assert tf.fingerprint(LanceDbIndexConfig(truncate_dim=64)) != tf.fingerprint(
        LanceDbIndexConfig(truncate_dim=128)
    )
    assert tf.fingerprint(LanceDbIndexConfig(truncate_dim=None)) != tf.fingerprint(
        LanceDbIndexConfig(truncate_dim=384)
    )


def test_fingerprint_takes_no_arguments_for_the_executor():
    """`executor.run` calls `instance.fingerprint()` with no config."""
    assert LanceDbIndex().fingerprint() == LanceDbIndex().fingerprint(
        LanceDbIndexConfig()
    )
    assert LanceDbIndex().fingerprint() != "none"


# --------------------------------------------------------------------------
# registration
# --------------------------------------------------------------------------


def test_registered_under_the_index_stage():
    from core.ports import Stage
    from core.registry import registry

    assert registry.get(Stage.INDEX, "lancedb") is LanceDbIndex
    assert LanceDbIndex.provides == {"backends": ["dense", "fts"]}
    assert LanceDbIndex.inputs["chunks"].variadic
