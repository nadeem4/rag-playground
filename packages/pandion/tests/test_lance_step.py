"""The `lancedb` index step builds its table through LanceStore."""

import json

from pandion.embeddings import get_embedder
from pandion.index_lance import LanceSettings, LanceStore
from pandion.index_store import NO_FILTER
from pandion.payloads import Chunk, ChunkSet
from pandion.plugins.index.lancedb_store import TABLE
from test_index_lancedb import build, chunk_set, descriptor_of


def _collection(index_dir, fts=True):
    return LanceStore(LanceSettings(location=str(index_dir), fts=fts))


def _vector(text):
    return get_embedder("fake-deterministic").embed([text])[0]


def test_the_step_writes_a_collection_the_store_can_open(tmp_path):
    index_dir, _, _ = build(tmp_path, chunk_set("alpha one", "beta two", doc_id="d1"), chunk_set("gamma", doc_id="d2"))
    col = _collection(index_dir).open(TABLE)
    desc = descriptor_of(index_dir)

    assert col is not None
    meta = col.meta()
    assert (meta.embed_model, meta.embed_revision, meta.dims, meta.metric) == (
        desc["embedding_model"], desc["embedding_revision"], desc["dim"], desc["metric"],
    )
    versions = col.documents()
    assert set(versions) == {"d1", "d2"} and all(len(v) == 16 for v in versions.values())


def test_a_row_round_trips_its_chunk_and_page_metadata(tmp_path):
    chunk = Chunk(id="d-0", text="Paris is the capital", ordinal=0, doc_id="d", page_span=(3, 4), heading_path=["A", "B"])
    payload = ChunkSet(chunks=[chunk], doc_id="d", source_text="x").model_dump(mode="json")
    index_dir, _, _ = build(tmp_path, payload)
    hit = _collection(index_dir).open(TABLE).search_dense(_vector("Paris is the capital"), 1, NO_FILTER)[0]

    assert Chunk.model_validate(json.loads(hit.row.chunk)) == chunk
    assert hit.row.metadata["page_start"] == 3 and hit.row.metadata["page_end"] == 4
    assert hit.row.metadata["section"] == ["A", "B"] and hit.row.metadata["ordinal"] == 0
    assert hit.row.roles == []


def test_a_piece_without_pages_has_no_page_metadata(tmp_path):
    index_dir, _, _ = build(tmp_path, chunk_set("no pages here"))
    hit = _collection(index_dir).open(TABLE).search_dense(_vector("no pages here"), 1, NO_FILTER)[0]

    assert "page_start" not in hit.row.metadata


def test_the_same_chunks_give_the_same_doc_version_and_a_changed_chunk_gives_another(tmp_path):
    def sets(*ids):
        chunks = [Chunk(id=i, text=i, ordinal=n, doc_id="doc-1") for n, i in enumerate(ids)]
        return ChunkSet(chunks=chunks, doc_id="doc-1", source_text="x").model_dump(mode="json")

    a, _, _ = build(tmp_path / "a", sets("one", "two"))
    b, _, _ = build(tmp_path / "b", sets("one", "two"))
    c, _, _ = build(tmp_path / "c", sets("one", "three"))

    def version(d):
        return _collection(d).open(TABLE).documents()["doc-1"]

    assert version(a) == version(b)
    assert version(a) != version(c)


def test_build_fts_false_builds_no_full_text_side(tmp_path):
    index_dir, _, _ = build(tmp_path, chunk_set("Paris is the capital"), build_fts=False)

    assert descriptor_of(index_dir)["backends"] == ["dense"]
    assert _collection(index_dir, fts=False).capabilities().lexical is None
