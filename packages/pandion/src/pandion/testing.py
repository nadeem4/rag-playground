"""Checks that prove an index store keeps the contract.

    from pandion.testing import store_conformance
    store_conformance(lambda: MyStore(MySettings()))

Each check gets a fresh store from the factory. The first failure raises
`AssertionError("<check name>: <why>")`.
"""

from __future__ import annotations

from collections.abc import Callable

from pandion.index_store import (
    NO_FILTER, AnyOf, And, Eq, In, IndexMeta, IndexRow, IndexStore,
)

STORE_CHECKS: dict[str, Callable[[IndexStore], None]] = {}


def _check(fn):
    STORE_CHECKS[fn.__name__.removeprefix("check_")] = fn
    return fn


def _meta() -> IndexMeta:
    return IndexMeta(embed_model="m", embed_revision="1", dims=3, metric="cosine", recipe_hash="h")


def _row(id, doc, vector, roles=("staff",), text="plain words", version="v1", metadata=None, chunk="{}") -> IndexRow:
    return IndexRow(
        id=id, doc_id=doc, doc_version=version, text=text, vector=list(vector),
        roles=list(roles), metadata=metadata or {}, chunk=chunk,
    )


def _col(store: IndexStore, rows=()):
    col = store.create("c", _meta())
    col.write_all(rows)
    return col


def _ids(hits) -> list[str]:
    return [h.row.id for h in hits]


def _expect(ok: bool, why: str) -> None:
    if not ok:
        raise AssertionError(why)


@_check
def check_create_then_open_returns_the_same_meta(store):
    store.create("c", _meta())
    col = store.open("c")
    _expect(col is not None and col.meta() == _meta(), "open did not return the meta given to create")


@_check
def check_open_unknown_name_returns_none(store):
    _expect(store.open("missing") is None, "open of an unknown name must return None")


@_check
def check_drop_removes_the_collection_and_list_shows_names(store):
    store.create("a", _meta())
    store.create("b", _meta())
    _expect(sorted(store.list()) == ["a", "b"], "list must show every collection name")
    store.drop("a")
    _expect(store.open("a") is None and store.list() == ["b"], "drop must remove the collection")
    store.drop("never_existed")


@_check
def check_write_all_then_documents_maps_doc_id_to_version(store):
    col = _col(store, [_row("1", "d1", [1, 0, 0], version="v1"), _row("2", "d2", [0, 1, 0], version="v2")])
    _expect(col.documents() == {"d1": "v1", "d2": "v2"}, "documents must map doc_id to doc_version")


@_check
def check_replace_document_swaps_only_that_document(store):
    if not store.capabilities().incremental:
        return
    col = _col(store, [_row("1", "d1", [1, 0, 0]), _row("2", "d2", [0, 1, 0])])
    col.replace_document("d1", [_row("3", "d1", [0, 0, 1], version="v2")])
    got = _ids(col.search_dense([1, 1, 1], 10, NO_FILTER))
    _expect(sorted(got) == ["2", "3"] and col.documents()["d1"] == "v2", "replace_document must swap only that document")


@_check
def check_delete_document_removes_its_rows(store):
    if not store.capabilities().incremental:
        return
    col = _col(store, [_row("1", "d1", [1, 0, 0]), _row("2", "d2", [0, 1, 0])])
    col.delete_document("d1")
    _expect(_ids(col.search_dense([1, 1, 0], 10, NO_FILTER)) == ["2"] and "d1" not in col.documents(),
            "delete_document must remove its rows")


@_check
def check_dense_returns_nearest_first_and_at_most_k(store):
    col = _col(store, [_row("far", "d", [0, 1, 0]), _row("near", "d", [1, 0.1, 0]), _row("mid", "d", [1, 1, 0])])
    got = _ids(col.search_dense([1, 0, 0], 2, NO_FILTER))
    _expect(got == ["near", "mid"], f"expected nearest first and at most k, got {got}")


@_check
def check_dense_filters_before_ranking(store):
    col = _col(store, [
        _row("best", "d", [1, 0, 0], metadata={"category": "x"}),
        _row("next", "d", [0.9, 0.4, 0], metadata={"category": "y"}),
    ])
    got = _ids(col.search_dense([1, 0, 0], 1, Eq("category", "y")))
    _expect(got == ["next"], f"the filter must apply before k, got {got}")


@_check
def check_any_of_roles_matches_any_overlap(store):
    col = _col(store, [_row("1", "d", [1, 0, 0], roles=["a", "b"]), _row("2", "d", [0, 1, 0], roles=["c"])])
    got = _ids(col.search_dense([1, 1, 0], 10, AnyOf("roles", ("b", "z"))))
    _expect(got == ["1"], f"any_of roles must match any overlap, got {got}")


@_check
def check_a_row_with_no_roles_is_never_returned(store):
    meta = {"category": "x"}
    col = _col(store, [_row("open", "d", [1, 0, 0], roles=["a"], text="shared word", metadata=meta),
                       _row("none", "d", [1, 0, 0], roles=[], text="shared word", metadata=meta)])
    roles = AnyOf("roles", ("a", "b"))
    for label, where in (("alone", roles), ("inside and", And((roles, Eq("category", "x"))))):
        _expect(_ids(col.search_dense([1, 0, 0], 10, where)) == ["open"],
                f"dense search returned a row with no roles ({label})")
        if store.capabilities().lexical:
            _expect(_ids(col.search_lexical("shared", 10, where)) == ["open"],
                    f"lexical search returned a row with no roles ({label})")


@_check
def check_empty_any_of_matches_nothing(store):
    col = _col(store, [_row("1", "d", [1, 0, 0], text="plain words")])
    where = AnyOf("roles", ())
    _expect(col.search_dense([1, 0, 0], 10, where) == [], "an empty any_of must match nothing")
    if store.capabilities().lexical:
        _expect(col.search_lexical("plain", 10, where) == [], "an empty any_of must match nothing in lexical search")


@_check
def check_eq_in_and_filters_on_metadata(store):
    col = _col(store, [
        _row("1", "d", [1, 0, 0], metadata={"category": "contracts", "pages": 3}),
        _row("2", "d", [0, 1, 0], metadata={"category": "contracts", "pages": 9}),
        _row("3", "d", [0, 0, 1], metadata={"category": "memos", "pages": 3}),
    ])
    where = And((Eq("category", "contracts"), In("pages", (2, 3))))
    got = _ids(col.search_dense([1, 1, 1], 10, where))
    _expect(got == ["1"], f"eq, in and and must filter on metadata, got {got}")


@_check
def check_lexical_search_finds_the_word(store):
    if not store.capabilities().lexical:
        return
    col = _col(store, [_row("1", "d", [1, 0, 0], text="the quarterly invoice"), _row("2", "d", [0, 1, 0], text="holiday photos")])
    got = _ids(col.search_lexical("invoice", 10, NO_FILTER))
    _expect(got == ["1"], f"lexical search must find the word, got {got}")


@_check
def check_lexical_search_applies_the_filter(store):
    if not store.capabilities().lexical:
        return
    col = _col(store, [
        _row("1", "d", [1, 0, 0], text="invoice", metadata={"category": "x"}),
        _row("2", "d", [0, 1, 0], text="invoice", metadata={"category": "y"}),
    ])
    got = _ids(col.search_lexical("invoice", 10, Eq("category", "y")))
    _expect(got == ["2"], f"lexical search must apply the filter, got {got}")


@_check
def check_capabilities_declare_any_of(store):
    _expect("any_of" in store.capabilities().filters, "a store must support the any_of filter")


@_check
def check_rows_round_trip_every_field(store):
    row = _row("1", "d1", [0.5, 0.25, 0.125], roles=["a", "b"], text="cited text", version="v7",
               metadata={"tags": ["x", "y"], "pages": 3, "ok": True, "score": 0.5, "section": "Intro"},
               chunk='{"id": "1", "text": "cited text"}')
    col = _col(store, [row])
    hits = col.search_dense([0.5, 0.25, 0.125], 1, NO_FILTER)
    _expect(len(hits) == 1 and hits[0].row == row, "a row must come back with every field unchanged")


def store_conformance(factory: Callable[[], IndexStore]) -> None:
    """Run every check on a fresh store; raise AssertionError(f"{name}: {why}") on the first failure."""
    for name, check in STORE_CHECKS.items():
        try:
            check(factory())
        except AssertionError as e:
            raise AssertionError(f"{name}: {e}") from None
        except Exception as e:
            raise AssertionError(f"{name}: {type(e).__name__}: {e}") from None
