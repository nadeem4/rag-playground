"""The index store contract: filters, capabilities and the store registry."""

import pytest
from pydantic import BaseModel

from pandion import index_store
from pandion.index_memory import MemorySettings, MemoryStore
from pandion.index_store import (
    IndexMeta,
    NO_FILTER, AnyOf, And, Capabilities, Eq, In, IndexRow, StoreRefused,
    check_store, get_store, matches, register_store, store_names,
)


def _row(**kw) -> IndexRow:
    base = dict(id="r1", doc_id="d1", doc_version="v1", text="hello", vector=[1.0, 0.0, 0.0], roles=["a", "b"], chunk="{}")
    base.update(kw)
    return IndexRow(**base)


def _caps(**kw) -> Capabilities:
    base = dict(incremental=True, lexical="fts", filters={"eq", "in", "any_of", "and"}, metrics={"cosine", "dot", "l2"})
    base.update(kw)
    return Capabilities(**base)


def test_any_of_matches_any_overlap():
    row = _row(roles=["a", "b"])
    assert matches(row, AnyOf("roles", ("b", "z")))
    assert not matches(row, AnyOf("roles", ("x",)))


def test_a_row_with_no_roles_matches_no_any_of():
    row = _row(roles=[])
    assert not matches(row, AnyOf("roles", ("a",)))
    assert not matches(row, AnyOf("roles", ()))


def test_eq_in_and_read_metadata():
    row = _row(metadata={"category": "contracts", "pages": 3})
    assert matches(row, Eq("category", "contracts"))
    assert matches(row, In("pages", (2, 3)))
    assert matches(row, And((Eq("category", "contracts"), In("pages", (2, 3)))))
    assert not matches(row, Eq("category", "memos"))
    assert not matches(row, In("pages", (4,)))
    assert not matches(row, And((Eq("category", "contracts"), In("pages", (4,)))))


def test_no_filter_matches_everything():
    assert matches(_row(), NO_FILTER)


def test_register_store_refuses_a_duplicate_and_names_both_modules(monkeypatch):
    monkeypatch.setattr(index_store, "_STORES", dict(index_store._STORES))
    first = type("First", (), {"name": "dup", "settings_model": BaseModel, "__module__": "mod_one"})
    second = type("Second", (), {"name": "dup", "settings_model": BaseModel, "__module__": "mod_two"})
    register_store(first)
    with pytest.raises(ValueError) as err:
        register_store(second)
    assert "mod_one" in str(err.value) and "mod_two" in str(err.value)


def test_get_store_builds_from_its_settings_model(monkeypatch):
    monkeypatch.setattr(index_store, "_STORES", dict(index_store._STORES))
    class Settings(BaseModel):
        path: str = "x"

    @register_store
    class Built:
        name = "built_from_settings"
        settings_model = Settings

        def __init__(self, settings):
            self.settings = settings

    store = get_store("built_from_settings", {"path": "y"})
    assert store.settings.path == "y"
    assert "built_from_settings" in store_names()


def test_get_store_unknown_name_lists_the_known_ones():
    with pytest.raises(ValueError, match="memory"):
        get_store("nope")


def test_check_store_refuses_a_store_without_any_of():
    with pytest.raises(StoreRefused, match="roles"):
        check_store("weak", _caps(filters={"eq"}))


def test_check_store_refuses_lexical_when_the_store_has_none():
    with pytest.raises(StoreRefused, match="BM25"):
        check_store("dense_only", _caps(lexical=None), lexical=True)


def test_check_store_refuses_a_metric_it_lacks():
    with pytest.raises(StoreRefused, match="cosine"):
        check_store("cosine_only", _caps(metrics={"cosine"}), metric="l2")


def test_check_store_passes_a_capable_store():
    check_store("good", _caps(), lexical=True, metric="dot")


def test_the_memory_store_is_listed_as_a_stable_store_plugin():
    from pandion.plugins import plugin_listing

    rows = [r for r in plugin_listing() if r["kind"] == "store" and r["name"] == "memory"]
    assert rows and rows[0]["level"] == "stable"


def test_a_bool_never_equals_a_number_in_eq_and_in():
    row = _row(metadata={"flag": True, "n": 1})
    assert matches(row, Eq("flag", True))
    assert not matches(row, Eq("flag", 1))
    assert not matches(row, Eq("n", True))
    assert not matches(row, In("flag", (1,)))
    assert matches(row, In("n", (1,)))


def _meta(metric="cosine", dims=2) -> IndexMeta:
    return IndexMeta(embed_model="m", embed_revision="1", dims=dims, metric=metric, recipe_hash="h")


def test_memory_store_create_of_an_existing_name_raises():
    store = MemoryStore(MemorySettings())
    store.create("c", _meta())
    with pytest.raises(ValueError, match="already exists"):
        store.create("c", _meta())


def test_memory_store_refuses_a_vector_of_the_wrong_length_naming_dims():
    col = MemoryStore(MemorySettings()).create("c", _meta(dims=2))
    with pytest.raises(ValueError, match="dims"):
        col.write_all([_row(vector=[1.0, 0.0, 0.0])])
    with pytest.raises(ValueError, match="dims"):
        col.replace_document("d1", [_row(vector=[1.0])])


def test_memory_store_dot_ranks_higher_first():
    col = MemoryStore(MemorySettings()).create("c", _meta("dot"))
    col.write_all([_row(id="small", vector=[1.0, 0.0]), _row(id="big", vector=[3.0, 0.0])])
    hits = col.search_dense([1.0, 0.0], 2, NO_FILTER)
    assert [h.row.id for h in hits] == ["big", "small"]
    assert hits[0].score == 3.0


def test_memory_store_l2_score_is_the_negative_distance():
    col = MemoryStore(MemorySettings()).create("c", _meta("l2"))
    col.write_all([_row(id="far", vector=[4.0, 0.0]), _row(id="near", vector=[1.0, 0.0])])
    hits = col.search_dense([0.0, 0.0], 2, NO_FILTER)
    assert [h.row.id for h in hits] == ["near", "far"]
    assert hits[0].score == -1.0 and hits[1].score == -4.0
