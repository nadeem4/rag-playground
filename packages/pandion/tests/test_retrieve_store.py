"""Retrievers read through the index store: filters, capabilities and the role re-check."""

import logging

import pytest

from pandion import filters as F
from pandion.index_store import AnyOf, And, In, NO_FILTER, StoreHit, IndexRow
from pandion.payloads import Chunk, ChunkSet, Query, RetrievalResult
from pandion.plugins.retrieve import _base
from pandion.plugins.retrieve.bm25 import Bm25Retriever
from pandion.plugins.retrieve.dense import DenseRetriever
from pandion.plugins.retrieve.hybrid_rrf import HybridRrfRetriever
from pandion.ports import RunContext
from test_index_lancedb import build


def paged(*spans, doc_id="doc-1", roles=None):
    """A chunk set with one piece per page span (None: a piece with no pages)."""
    chunks = [
        Chunk(id=f"{doc_id}-{i}", text=f"piece number {i} about topic", ordinal=i, doc_id=doc_id, page_span=span)
        for i, span in enumerate(spans)
    ]
    return ChunkSet(chunks=chunks, doc_id=doc_id, source_text="x").model_dump(mode="json")


def run(transform, binding, query, tmp_path, extras=None, **config):
    ctx = RunContext(output_dir=tmp_path / "o", emit=lambda e: None, tmp=tmp_path / "t", extras=extras or {})
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    payload = transform.apply(
        {"index": binding, "query": query.model_dump(mode="json")}, transform.config_model(**config), ctx
    )
    return RetrievalResult.model_validate(payload)


ALL = [DenseRetriever(), Bm25Retriever(), HybridRrfRetriever()]


@pytest.mark.parametrize("retriever", ALL, ids=lambda t: t.name)
def test_dense_bm25_and_hybrid_read_a_binding(tmp_path, retriever):
    binding, _, _ = build(tmp_path, paged(None, None))
    result = run(retriever, binding, Query(text="piece number topic"), tmp_path)

    assert {h.chunk.id for h in result.hits} == {"doc-1-0", "doc-1-1"}


def test_a_pages_filter_overlaps_like_before(tmp_path):
    binding, _, _ = build(tmp_path, paged((28, 31), (31, 32), None))
    query = Query(text="piece number topic", filters={"pages": [10, 30]})
    result = run(DenseRetriever(), binding, query, tmp_path)

    assert [h.chunk.id for h in result.hits] == ["doc-1-0"]


def test_a_pages_filter_with_a_huge_last_page_stays_small():
    flt = F.store_filter({"pages": [1, 2147483647]}, None, {"sections": 0, "max_page": 5})

    assert flt == And((AnyOf("pages", ("1", "2", "3", "4", "5")),))


def test_section_and_document_filters_translate():
    flt = F.store_filter({"doc_ids": ["a", "b"], "section": "Intro"}, None, {"sections": 2, "max_page": 0})

    assert flt == And((In("doc_id", ("a", "b")), AnyOf("section", ("Intro",))))


def test_store_filter_with_nothing_set_is_no_filter():
    assert F.store_filter(None, None, {"sections": 0}) == NO_FILTER


def test_store_filter_adds_the_roles_it_is_given():
    assert F.store_filter(None, ["hr", "staff"], {}) == And((AnyOf("roles", ("hr", "staff")),))
    assert F.store_filter(None, [], {}) == And((AnyOf("roles", ()),))


def test_a_missing_collection_names_the_store_and_the_fix(tmp_path):
    binding, _, _ = build(tmp_path, paged(None))
    binding = {**binding, "collection": "gone"}

    with pytest.raises(ValueError, match="'gone' is not in the lancedb store.*index.sync"):
        _base.open_index(binding)


# -- the role re-check --------------------------------------------------


def hit(row_id, roles):
    row = IndexRow(id=row_id, doc_id="d", doc_version="v", text="secret words", vector=[1.0], roles=roles, chunk="{}")
    return StoreHit(row=row, score=1.0)


def test_recheck_with_roles_none_is_a_no_op():
    hits = [hit("a", []), hit("b", ["hr"])]

    assert _base.recheck(hits, None, retriever="dense") == hits


def test_recheck_keeps_only_rows_that_share_a_role():
    kept = _base.recheck([hit("a", ["hr"]), hit("b", ["staff"]), hit("c", [])], ["hr"], retriever="dense")

    assert [h.row.id for h in kept] == ["a"]
    assert _base.recheck([hit("a", ["hr"])], [], retriever="dense") == []


def test_the_log_line_has_ids_and_no_text(caplog):
    with caplog.at_level(logging.WARNING, logger="pandion.access"):
        _base.recheck([hit("row-9", ["hr"])], ["staff"], retriever="bm25")

    assert [r.getMessage() for r in caplog.records] == [
        "dropped row row-9 of d: roles did not match (retriever bm25)"
    ]
    assert "secret" not in caplog.text


class Leaky:
    """A collection that ignores every filter, like a buggy store plugin."""

    def __init__(self, inner):
        self.inner = inner

    def search_dense(self, vector, k, where):
        return self.inner.search_dense(vector, k, NO_FILTER)

    def search_lexical(self, text, k, where):
        return self.inner.search_lexical(text, k, NO_FILTER)

    def __getattr__(self, name):
        return getattr(self.inner, name)


def roled(*pairs):
    chunks = [Chunk(id=i, text="same shared words", ordinal=n, doc_id=i) for n, (i, _) in enumerate(pairs)]
    return [
        ChunkSet(chunks=[c], doc_id=c.doc_id, source_text="x").model_dump(mode="json") for c in chunks
    ], {i: r for i, r in pairs}


@pytest.fixture
def leaky(monkeypatch):
    real = _base.open_binding
    monkeypatch.setattr(_base, "open_binding", lambda binding: Leaky(real(binding)))


@pytest.mark.parametrize("retriever", ALL, ids=lambda t: t.name)
def test_a_row_the_store_leaks_is_dropped_and_logged(tmp_path, caplog, leaky, retriever):
    sets, roles = roled(("open", ["staff"]), ("closed", ["hr"]))
    binding, _, _ = build(tmp_path, *sets, doc_roles=roles)
    query = Query(text="same shared words")

    with caplog.at_level(logging.WARNING, logger="pandion.access"):
        result = run(retriever, binding, query, tmp_path, extras={"roles": ["staff"]})

    assert {h.chunk.doc_id for h in result.hits} == {"open"}
    assert "dropped row closed of closed" in caplog.text


def test_hybrid_rechecks_before_fusion(tmp_path, leaky):
    sets, roles = roled(("open", ["staff"]), ("closed", ["hr"]))
    binding, _, _ = build(tmp_path, *sets, doc_roles=roles)
    result = run(
        HybridRrfRetriever(), binding, Query(text="same shared words"), tmp_path, extras={"roles": ["staff"]}
    )

    assert [h.chunk.doc_id for h in result.hits] == ["open"]
    assert result.total_candidates == 1


def test_roles_come_from_the_run_not_from_the_questions_filters(tmp_path, leaky):
    """A rewrite step that drops `filters` must not lift the roles check."""
    sets, roles = roled(("open", ["staff"]), ("closed", ["hr"]))
    binding, _, _ = build(tmp_path, *sets, doc_roles=roles)
    dropped = Query(text="same shared words", filters=None)
    result = run(DenseRetriever(), binding, dropped, tmp_path, extras={"roles": ["staff"]})

    assert {h.chunk.doc_id for h in result.hits} == {"open"}


def test_no_roles_in_the_run_leaves_the_search_unfiltered(tmp_path):
    sets, roles = roled(("open", ["staff"]), ("closed", ["hr"]))
    binding, _, _ = build(tmp_path, *sets, doc_roles=roles)
    result = run(DenseRetriever(), binding, Query(text="same shared words"), tmp_path)

    assert {h.chunk.doc_id for h in result.hits} == {"open", "closed"}


def test_an_empty_role_list_finds_nothing(tmp_path, leaky):
    sets, roles = roled(("open", ["staff"]))
    binding, _, _ = build(tmp_path, *sets, doc_roles=roles)
    result = run(DenseRetriever(), binding, Query(text="same shared words"), tmp_path, extras={"roles": []})

    assert result.hits == []


# -- refusing a pairing the store cannot serve -------------------------------


class CappedStore:
    """The real store with some capabilities taken away."""

    def __init__(self, inner, filters=None):
        self.inner = inner
        self.filters = filters

    def capabilities(self):
        update = {"lexical": None}
        if self.filters is not None:
            update["filters"] = self.filters
        return self.inner.capabilities().model_copy(update=update)

    def __getattr__(self, name):
        return getattr(self.inner, name)


@pytest.fixture
def capped(monkeypatch):
    real = _base.get_store

    def install(**kw):
        monkeypatch.setattr(_base, "get_store", lambda name, settings=None: CappedStore(real(name, settings), **kw))

    return install


def test_bm25_on_a_store_with_no_text_search_is_refused(tmp_path, capped):
    binding, _, _ = build(tmp_path, paged(None))
    capped()

    with pytest.raises(ValueError, match="lancedb store has no text search.*dense retrieval"):
        run(Bm25Retriever(), binding, Query(text="piece"), tmp_path)


def test_hybrid_on_such_a_store_is_refused(tmp_path, capped):
    binding, _, _ = build(tmp_path, paged(None))
    capped()

    with pytest.raises(ValueError, match="no text search"):
        run(HybridRrfRetriever(), binding, Query(text="piece"), tmp_path)


def test_dense_on_such_a_store_is_fine(tmp_path, capped):
    binding, _, _ = build(tmp_path, paged(None))
    capped()

    assert run(DenseRetriever(), binding, Query(text="piece"), tmp_path).hits


def test_a_store_that_cannot_filter_any_of_is_refused_when_access_is_on(tmp_path, capped):
    binding, _, _ = build(tmp_path, paged(None))
    capped(filters={"eq", "in", "and"})

    with pytest.raises(ValueError, match="cannot filter by any of a list of roles.*another store"):
        run(DenseRetriever(), binding, Query(text="piece"), tmp_path, extras={"roles": ["staff"]})
    assert run(DenseRetriever(), binding, Query(text="piece"), tmp_path).hits
