"""A hit and a citation name the document they came from."""

import json
from types import SimpleNamespace

from pandion.index_memory import MemorySettings, MemoryStore
from pandion.index_store import NO_FILTER, IndexMeta, IndexRow
from pandion.payloads import Chunk
from pandion.plugins.answer.chat import _citation
from pandion.plugins.retrieve._base import make_hit


def _hit(metadata):
    """A hand-built row, written to a memory collection and read back by a search."""
    chunk = json.dumps(Chunk(id="c1", text="Paris", doc_id="d1").model_dump(mode="json"))
    row = IndexRow(id="c1", doc_id="d1", doc_version="v", text="Paris", vector=[1.0], metadata=metadata, chunk=chunk)
    meta = IndexMeta(embed_model="m", embed_revision="1", dims=1, metric="cosine", recipe_hash="h")
    collection = MemoryStore(MemorySettings()).create("c", meta)
    collection.write_all([row])
    return collection.search_dense([1.0], 1, NO_FILTER)[0], chunk


def test_a_hit_carries_its_documents_source_fields():
    hit, _ = _hit({"ordinal": 0, "source_id": "hr/pay.pdf", "source_owner": "hr"})

    made = make_hit(hit, rank=1, score=0.5, retriever="dense")

    assert made.chunk.metadata["source"] == {"id": "hr/pay.pdf", "owner": "hr"}


def test_a_hit_from_a_row_without_source_fields_has_no_source_key():
    hit, _ = _hit({"ordinal": 0})

    made = make_hit(hit, rank=1, score=0.5, retriever="dense")

    assert "source" not in made.chunk.metadata


def test_the_canonical_chunk_json_is_not_changed():
    hit, chunk = _hit({"source_id": "a.pdf"})

    make_hit(hit, rank=1, score=0.5, retriever="dense")

    assert hit.row.chunk == chunk


def _quote():
    return SimpleNamespace(cited_text="Paris", start_char_index=0, end_char_index=5)


def test_a_citation_names_its_source():
    piece = SimpleNamespace(
        id="c1", doc_id="b" * 64, text="Paris is.", start_char=0, page_span=None, metadata={"source": {"id": "a.pdf"}}
    )

    entry = _citation(1, _quote(), piece, SimpleNamespace(source_id="a" * 64), "", {}, {})

    assert entry["source"] == {"id": "a.pdf"}


def test_a_citation_without_a_source_has_an_empty_one():
    piece = SimpleNamespace(id="c1", doc_id="b" * 64, text="Paris is.", start_char=0, page_span=None, metadata={})

    entry = _citation(1, _quote(), piece, SimpleNamespace(source_id="a" * 64), "", {}, {})

    assert entry["source"] == {}
    assert _citation(1, _quote(), None, SimpleNamespace(source_id="a" * 64), "", {}, {})["source"] == {}
