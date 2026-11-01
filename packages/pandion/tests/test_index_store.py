"""The index store contract: filters, capabilities and the store registry."""

import pytest
from pydantic import BaseModel

from pandion.index_store import (
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


def test_register_store_refuses_a_duplicate_and_names_both_modules():
    first = type("First", (), {"name": "dup", "settings_model": BaseModel, "__module__": "mod_one"})
    second = type("Second", (), {"name": "dup", "settings_model": BaseModel, "__module__": "mod_two"})
    register_store(first)
    with pytest.raises(ValueError) as err:
        register_store(second)
    assert "mod_one" in str(err.value) and "mod_two" in str(err.value)


def test_get_store_builds_from_its_settings_model():
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
