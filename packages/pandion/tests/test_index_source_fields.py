"""Index rows carry the source's facts: the document id and its labels."""

import pytest

from pandion.embeddings import get_embedder
from pandion.index_store import NO_FILTER, open_binding
from pandion.plugins.index.lancedb_store import LanceDbIndexConfig, source_fields
from test_index_lancedb import build, chunk_set


def _hit(binding, text):
    vector = get_embedder("fake-deterministic").embed([text])[0]
    return open_binding(binding).search_dense(vector, 1, NO_FILTER)[0]


def test_rows_carry_the_document_id_and_labels_as_source_fields(tmp_path):
    sources = {"d1": {"id": "hr/pay.pdf", "owner": "hr", "Content-Type": "application/pdf"}}
    binding, _, _ = build(tmp_path, chunk_set("alpha one", doc_id="d1"), doc_sources=sources)

    metadata = _hit(binding, "alpha one").row.metadata

    assert metadata["source_id"] == "hr/pay.pdf"
    assert metadata["source_owner"] == "hr"
    assert metadata["source_content_type"] == "application/pdf"


def test_the_roles_label_is_not_copied_into_source_fields():
    assert source_fields({"id": "a.pdf", "roles": "hr", "team": "x"}) == {"source_id": "a.pdf", "source_team": "x"}


def test_label_keys_are_made_safe_column_names():
    assert source_fields({"id": "a", "Content-Type": "t"}) == {"source_id": "a", "source_content_type": "t"}


def test_without_doc_sources_rows_are_as_before(tmp_path):
    binding, _, _ = build(tmp_path, chunk_set("alpha one", doc_id="d1"))

    assert not [k for k in _hit(binding, "alpha one").row.metadata if k.startswith("source_")]
    # Left out of the dump while empty, so an index built before this keeps its id.
    plain = LanceDbIndexConfig(embedder="fake-deterministic")
    assert "doc_sources" not in plain.model_dump()
    assert LanceDbIndexConfig(embedder="fake-deterministic", doc_sources=None).model_dump() == plain.model_dump()
    assert "doc_sources" in LanceDbIndexConfig(embedder="fake-deterministic", doc_sources={"d": {"id": "x"}}).model_dump()


def test_settings_never_reach_rows():
    # The step is given only labels and ids: no field can carry a source's settings.
    assert not [f for f in LanceDbIndexConfig.model_fields if "storage" in f or f in ("settings", "source")]
    assert source_fields({"id": "a", "token": "label-value"}) == {"source_id": "a", "source_token": "label-value"}


def test_source_fields_work_in_qdrant(tmp_path):
    pytest.importorskip("qdrant_client")
    from pandion.embedding_cache import EmbeddingCache
    from pandion.plugins.index.qdrant_store import QdrantIndex, QdrantIndexConfig
    from pandion.ports import RunContext
    from pandion.storage import Store

    ctx = RunContext(
        output_dir=tmp_path / "out", emit=lambda e: None, tmp=tmp_path / "tmp",
        extras={"embedding_cache": EmbeddingCache(tmp_path / "emb"), "index_location": str(tmp_path / "q"),
                "artifact_id": "a" * 64, "recipe_hash": "r" * 64},
    )
    ctx.output_dir.mkdir(parents=True), ctx.tmp.mkdir(parents=True)
    config = QdrantIndexConfig(embedder="fake-deterministic", doc_sources={"d1": {"id": "x.pdf", "owner": "hr"}})
    binding = QdrantIndex().apply({"chunks": [chunk_set("alpha one", doc_id="d1")]}, config, ctx)
    binding = {**binding, "settings": {**binding["settings"], "location": str(tmp_path / "q")}}

    metadata = _hit(binding, "alpha one").row.metadata

    assert metadata["source_id"] == "x.pdf" and metadata["source_owner"] == "hr"
