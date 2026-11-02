"""LanceStore: the LanceDB index store on the store contract."""

import json
from uuid import uuid4

import pytest

pytest.importorskip("lancedb")

from pandion.errors import FormatTooNew
from pandion.index_lance import LanceSettings, LanceStore, NoRows, to_sql
from pandion.index_store import NO_FILTER, AnyOf, And, Eq, In, IndexMeta, IndexRow, StoreRefused, check_store
from pandion.testing import STORE_CHECKS, store_conformance


def _meta(dims=3, metric="cosine") -> IndexMeta:
    return IndexMeta(embed_model="m", embed_revision="1", dims=dims, metric=metric, recipe_hash="h")


def _row(id, vector, **kw) -> IndexRow:
    base = dict(id=id, doc_id="d", doc_version="v1", text="plain words", vector=vector, roles=["a"], chunk="{}")
    base.update(kw)
    return IndexRow(**base)


DENSE_CHECKS = [n for n in STORE_CHECKS if not n.startswith("lexical_") and n != "rows_round_trip_every_field"]


@pytest.mark.parametrize("name", DENSE_CHECKS)
def test_lance_store_passes_the_conformance_suite_dense_half(name, tmp_path):
    STORE_CHECKS[name](LanceStore(LanceSettings(location=str(tmp_path / name))))


def test_open_after_reconnect_returns_the_same_meta(tmp_path):
    LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    col = LanceStore(LanceSettings(location=str(tmp_path))).open("c")
    assert col is not None and col.meta() == _meta()


def test_a_collection_with_a_newer_format_version_is_refused(tmp_path):
    import lancedb

    store = LanceStore(LanceSettings(location=str(tmp_path)))
    store.create("c", _meta())
    newer = _meta().model_copy(update={"format_version": 2}).model_dump()
    db = lancedb.connect(str(tmp_path))
    table = db.open_table("_pandion_meta")
    table.update(where="name = 'c'", values={"meta_json": json.dumps(newer)})
    del table, db
    with pytest.raises(FormatTooNew, match="upgrade pandion"):
        store.open("c")


def test_list_hides_the_meta_table_and_drop_removes_both(tmp_path):
    store = LanceStore(LanceSettings(location=str(tmp_path)))
    store.create("a", _meta())
    store.create("b", _meta())
    assert store.list() == ["a", "b"]
    store.drop("a")
    assert store.list() == ["b"] and store.open("a") is None
    import lancedb

    assert "a" not in lancedb.connect(str(tmp_path)).list_tables().tables


def test_a_metadata_key_that_changes_type_is_refused_by_name(tmp_path):
    col = LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    with pytest.raises(ValueError, match="pages"):
        col.write_all([_row("1", [1, 0, 0], metadata={"pages": 3}), _row("2", [0, 1, 0], metadata={"pages": "x"})])
    col.write_all([_row("1", [1, 0, 0], metadata={"pages": 3})])
    with pytest.raises(ValueError, match="pages"):
        col.replace_document("d", [_row("3", [0, 1, 0], metadata={"pages": "x"})])


def test_an_empty_any_of_inside_and_matches_nothing(tmp_path):
    col = LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    col.write_all([_row("1", [1, 0, 0], metadata={"category": "x"})])
    where = And((AnyOf("roles", ()), Eq("category", "x")))
    assert col.search_dense([1, 0, 0], 10, where) == []


def test_a_filter_on_a_missing_column_or_the_wrong_type_matches_nothing(tmp_path):
    col = LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    col.write_all([_row("1", [1, 0, 0], metadata={"flag": True, "pages": 1})])
    assert col.search_dense([1, 0, 0], 10, Eq("nope", "x")) == []
    assert col.search_dense([1, 0, 0], 10, Eq("flag", 1)) == []
    assert col.search_dense([1, 0, 0], 10, Eq("pages", True)) == []
    assert [h.row.id for h in col.search_dense([1, 0, 0], 10, Eq("flag", True))] == ["1"]


def test_to_sql_quotes_values():
    assert "'o''brien'" in to_sql(Eq("category", "o'brien"))
    assert to_sql(AnyOf("roles", ("a", "b"))) == "array_has_any(roles, ['a', 'b'])"
    assert to_sql(In("pages", (2, 3))) == "pages IN (2, 3)"
    assert to_sql(Eq("chunk", "x")) == "chunk_json = 'x'"
    assert to_sql(NO_FILTER) is None
    with pytest.raises(NoRows):
        to_sql(And((Eq("a", "x"), AnyOf("roles", ()))))


def test_lance_store_passes_the_conformance_suite(tmp_path):
    store_conformance(lambda: LanceStore(LanceSettings(location=str(tmp_path / uuid4().hex))))


def test_replace_document_keeps_the_other_documents_and_the_full_text_index_current(tmp_path):
    col = LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    col.write_all([_row("1", [1, 0, 0], text="old walrus"), _row("2", [0, 1, 0], doc_id="e", text="other penguin")])
    col.replace_document("d", [_row("3", [0, 0, 1], text="fresh giraffe")])
    assert [h.row.id for h in col.search_lexical("giraffe", 5, NO_FILTER)] == ["3"]
    assert col.search_lexical("walrus", 5, NO_FILTER) == []
    assert [h.row.id for h in col.search_lexical("penguin", 5, NO_FILTER)] == ["2"]


def test_replace_document_can_add_a_new_metadata_key(tmp_path):
    col = LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    col.write_all([_row("1", [1, 0, 0])])
    col.replace_document("e", [_row("2", [0, 1, 0], doc_id="e", metadata={"page_start": 4})])
    assert [h.row.id for h in col.search_dense([0, 1, 0], 5, Eq("page_start", 4))] == ["2"]


def test_write_all_twice_replaces_every_row(tmp_path):
    col = LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    col.write_all([_row("1", [1, 0, 0]), _row("2", [0, 1, 0])])
    col.write_all([_row("3", [0, 0, 1])])
    assert [h.row.id for h in col.search_dense([1, 1, 1], 10, NO_FILTER)] == ["3"]


def test_a_store_with_fts_off_declares_no_lexical_and_check_store_refuses_bm25(tmp_path):
    store = LanceStore(LanceSettings(location=str(tmp_path), fts=False))
    caps = store.capabilities()
    assert caps.lexical is None
    with pytest.raises(StoreRefused):
        check_store("lancedb", caps, lexical=True)
    col = store.create("c", _meta())
    col.write_all([_row("1", [1, 0, 0])])
    assert col.search_lexical("plain", 5, NO_FILTER) == []


def test_a_wrong_width_vector_is_refused_with_the_row_id(tmp_path):
    col = LanceStore(LanceSettings(location=str(tmp_path))).create("c", _meta())
    with pytest.raises(ValueError, match="Row 'bad' has 2 numbers but this collection's dims is 3"):
        col.write_all([_row("bad", [1, 0])])
    with pytest.raises(ValueError, match="Row 'bad'"):
        col.replace_document("d", [_row("bad", [1, 0])])
