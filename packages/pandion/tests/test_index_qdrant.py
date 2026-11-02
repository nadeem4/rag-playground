"""QdrantStore: the Qdrant index store on the store contract, run embedded (no server)."""

import os
from uuid import uuid4

import pytest

pytest.importorskip("qdrant_client")

from pandion.errors import FormatTooNew
from pandion.index_qdrant import QdrantSettings, QdrantStore
from pandion.index_store import NO_FILTER, AnyOf, And, Eq, In, IndexMeta, IndexRow, StoreRefused
from pandion.testing import STORE_CHECKS, store_conformance


def _meta(dims=3, metric="cosine") -> IndexMeta:
    return IndexMeta(embed_model="m", embed_revision="1", dims=dims, metric=metric, recipe_hash="h")


def _row(id, vector, **kw) -> IndexRow:
    base = dict(id=id, doc_id="d", doc_version="v1", text="plain words", vector=vector, roles=["a"], chunk="{}")
    base.update(kw)
    return IndexRow(**base)


def _store(**kw) -> QdrantStore:
    return QdrantStore(QdrantSettings(prefix=uuid4().hex, **kw))


def _ids(hits) -> list[str]:
    return [h.row.id for h in hits]


def test_qdrant_store_passes_the_conformance_suite():
    store_conformance(lambda: _store())


@pytest.mark.parametrize("name", list(STORE_CHECKS))
def test_qdrant_store_passes_each_check(name):
    STORE_CHECKS[name](_store())


def test_the_embedded_store_has_bm25_text_search():
    # The spike: local mode accepts sparse vectors with the IDF modifier.
    assert _store().capabilities().lexical == "bm25"


def test_the_key_is_read_from_the_named_environment_variable(monkeypatch):
    import qdrant_client

    seen = {}

    class Recorder:
        def __init__(self, **kw):
            seen.update(kw)

    monkeypatch.setattr(qdrant_client, "QdrantClient", Recorder)
    monkeypatch.setenv("MY_QDRANT_KEY", "secret")
    QdrantStore(QdrantSettings(url="http://q:6333", api_key_env="MY_QDRANT_KEY"))._connect()
    assert seen == {"url": "http://q:6333", "api_key": "secret"}


def test_an_unset_key_variable_is_named_in_the_error(monkeypatch):
    monkeypatch.delenv("MY_QDRANT_KEY", raising=False)
    with pytest.raises(ValueError, match="MY_QDRANT_KEY"):
        QdrantStore(QdrantSettings(url="http://q:6333", api_key_env="MY_QDRANT_KEY"))._connect()


def test_two_prefixes_do_not_see_each_others_collections(tmp_path):
    a = QdrantStore(QdrantSettings(location=str(tmp_path), prefix="a"))
    b = QdrantStore(QdrantSettings(location=str(tmp_path), prefix="b"))
    a.create("c", _meta())
    assert a.list() == ["c"] and b.list() == [] and b.open("c") is None


def test_a_folder_location_keeps_rows_across_two_store_objects(tmp_path):
    first = QdrantStore(QdrantSettings(location=str(tmp_path)))
    first.create("c", _meta()).write_all([_row("1", [1, 0, 0])])
    col = QdrantStore(QdrantSettings(location=str(tmp_path))).open("c")
    assert col is not None and col.meta() == _meta()
    assert _ids(col.search_dense([1, 0, 0], 5, NO_FILTER)) == ["1"]


def test_a_collection_with_a_newer_format_version_is_refused():
    store = _store()
    store.create("c", _meta().model_copy(update={"format_version": 2}))
    with pytest.raises(FormatTooNew, match="upgrade pandion"):
        store.open("c")


def test_an_empty_any_of_inside_and_matches_nothing():
    col = _store().create("c", _meta())
    col.write_all([_row("1", [1, 0, 0], metadata={"k": "x"})])
    where = And((Eq("k", "x"), AnyOf("roles", ())))
    assert col.search_dense([1, 0, 0], 5, where) == []
    assert col.search_lexical("plain", 5, where) == []
    assert col.search_dense([1, 0, 0], 5, And((Eq("k", "x"), In("k", ())))) == []


def test_in_with_floats_is_refused_with_a_sentence():
    col = _store().create("c", _meta())
    col.write_all([_row("1", [1, 0, 0])])
    with pytest.raises(StoreRefused, match="whole numbers and text"):
        col.search_dense([1, 0, 0], 5, In("x", (0.5,)))


def test_ids_that_are_not_uuids_round_trip():
    col = _store().create("c", _meta())
    col.write_all([_row("doc-1-3", [1, 0, 0])])
    assert _ids(col.search_dense([1, 0, 0], 5, NO_FILTER)) == ["doc-1-3"]


def _col_with_types():
    col = _store().create("c", _meta())
    col.write_all([
        _row("flag", [1, 0, 0], metadata={"v": True}),
        _row("one", [0, 1, 0], metadata={"v": 1}),
        _row("half", [0, 0, 1], metadata={"v": 0.5}),
        _row("none", [1, 1, 1], metadata={}),
    ])
    return col


def test_a_bool_never_equals_a_number_and_a_number_never_equals_a_bool():
    col = _col_with_types()
    assert _ids(col.search_dense([1, 1, 1], 9, Eq("v", True))) == ["flag"]
    assert _ids(col.search_dense([1, 1, 1], 9, Eq("v", 1))) == ["one"]
    assert _ids(col.search_dense([1, 1, 1], 9, Eq("v", 1.0))) == ["one"]
    assert _ids(col.search_dense([1, 1, 1], 9, Eq("v", 0.5))) == ["half"]
    assert _ids(col.search_dense([1, 1, 1], 9, In("v", (1, 2)))) == ["one"]
    assert _ids(col.search_dense([1, 1, 1], 9, In("v", (True,)))) == ["flag"]


def test_a_missing_field_matches_nothing_and_an_unknown_filter_field_finds_no_rows():
    col = _col_with_types()
    assert col.search_dense([1, 1, 1], 9, Eq("nope", 1)) == []
    assert col.search_dense([1, 1, 1], 9, AnyOf("nope", ("x",))) == []


def test_mixed_text_and_number_in_values_both_match():
    col = _store().create("c", _meta())
    col.write_all([_row("s", [1, 0, 0], metadata={"v": "x"}), _row("n", [0, 1, 0], metadata={"v": 2})])
    assert sorted(_ids(col.search_dense([1, 1, 0], 9, In("v", ("x", 2))))) == ["n", "s"]


def test_a_filter_on_chunk_or_vector_matches_nothing():
    col = _store().create("c", _meta())
    col.write_all([_row("1", [1, 0, 0])])
    for field in ("chunk", "chunk_json", "vector"):
        assert col.search_dense([1, 0, 0], 5, Eq(field, "{}")) == []
    assert col.search_dense([1, 0, 0], 5, Eq("id", "1")) != []


def test_roles_fail_closed_for_every_search():
    col = _store().create("c", _meta())
    col.write_all([_row("none", [1, 0, 0], roles=[]), _row("open", [1, 0, 0], roles=["a"])])
    where = AnyOf("roles", ("a", "b"))
    assert _ids(col.search_dense([1, 0, 0], 5, where)) == ["open"]
    assert _ids(col.search_lexical("plain", 5, where)) == ["open"]
    assert col.search_dense([1, 0, 0], 5, AnyOf("roles", ())) == []


def test_l2_scores_are_negative_distances_nearest_first():
    col = _store().create("c", _meta(metric="l2"))
    col.write_all([_row("far", [3, 0, 0]), _row("near", [1, 0, 0])])
    hits = col.search_dense([0, 0, 0], 2, NO_FILTER)
    assert _ids(hits) == ["near", "far"] and hits[0].score == pytest.approx(-1.0)


def test_a_wrong_width_vector_is_refused():
    col = _store().create("c", _meta(dims=3))
    with pytest.raises(ValueError, match="dims"):
        col.write_all([_row("1", [1, 0])])


def test_a_metadata_key_named_like_the_stored_row_id_is_refused():
    col = _store().create("c", _meta())
    with pytest.raises(ValueError, match="_row_id"):
        col.write_all([_row("1", [1, 0, 0], metadata={"_row_id": "x"})])


def test_a_prefix_with_two_underscores_is_refused():
    with pytest.raises(ValueError, match="__"):
        QdrantSettings(prefix="a__b")


def test_two_store_objects_on_one_folder_work_together(tmp_path):
    one = QdrantStore(QdrantSettings(location=str(tmp_path)))
    two = QdrantStore(QdrantSettings(location=str(tmp_path)))
    one.create("c", _meta()).write_all([_row("1", [1, 0, 0])])
    assert _ids(two.open("c").search_dense([1, 0, 0], 5, NO_FILTER)) == ["1"]
    two.open("c").write_all([_row("2", [1, 0, 0])])
    assert _ids(one.open("c").search_dense([1, 0, 0], 5, NO_FILTER)) == ["2"]


def test_without_a_keyword_index_there_is_no_text_search():
    store = _store(fts=False)
    assert store.capabilities().lexical is None
    col = store.create("c", _meta())
    col.write_all([_row("1", [1, 0, 0])])
    assert col.search_lexical("plain", 5, NO_FILTER) == []
    assert _ids(col.search_dense([1, 0, 0], 5, NO_FILTER)) == ["1"]


@pytest.mark.skipif(not os.environ.get("QDRANT_URL"), reason="set QDRANT_URL to run against a server")
def test_qdrant_conformance_against_a_server():
    store_conformance(lambda: QdrantStore(QdrantSettings(url=os.environ["QDRANT_URL"], prefix=uuid4().hex)))
