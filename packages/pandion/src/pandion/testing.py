"""Checks that prove an index store, or a conversation store, keeps the contract.

    from pandion.testing import store_conformance
    store_conformance(lambda: MyStore(MySettings()))

    from pandion.testing import conversation_store_conformance
    conversation_store_conformance(lambda: MyConversationStore(MySettings()))

    from pandion.testing import trace_store_conformance
    trace_store_conformance(lambda: MyConversationStore(MySettings()))  # only for a store that is also a TraceStore

Each check gets a fresh store from the factory. The first failure raises
`AssertionError("<check name>: <why>")`.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from pandion.conversation_store import (
    ConversationNotFound, ConversationStore, Memory, Turn, TITLE_LENGTH,
)
from pandion.trace_record import Feedback, TraceRecord
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
def check_in_and_eq_match_a_whole_number_stored_as_a_float(store):
    col = _col(store, [_row("1", "d", [1, 0, 0], metadata={"n": 1.0}), _row("2", "d", [0, 1, 0], metadata={"n": 2.0})])
    for where in (In("n", (1,)), Eq("n", 1)):
        got = _ids(col.search_dense([1, 1, 0], 10, where))
        _expect(got == ["1"], f"a whole number must match the same number stored as a float, got {got}")


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
    _expect(len(hits) == 1, "a search must find the row")
    got = hits[0].row
    # A store may return the vector scaled to length 1 (cosine); its direction must be the same.
    scale = sum(x * x for x in row.vector) ** 0.5
    same_direction = len(got.vector) == 3 and all(
        abs(g * scale / (sum(y * y for y in got.vector) ** 0.5 or 1) - w) < 1e-6 for g, w in zip(got.vector, row.vector)
    )
    _expect(
        got.model_copy(update={"vector": row.vector}) == row and same_direction,
        "a row must come back with every field unchanged (the vector may be scaled to length 1)",
    )


def store_conformance(factory: Callable[[], IndexStore]) -> None:
    """Run every check on a fresh store; raise AssertionError(f"{name}: {why}") on the first failure."""
    for name, check in STORE_CHECKS.items():
        try:
            check(factory())
        except AssertionError as e:
            raise AssertionError(f"{name}: {e}") from None
        except Exception as e:
            raise AssertionError(f"{name}: {type(e).__name__}: {e}") from None


CONVERSATION_CHECKS: dict[str, Callable[[ConversationStore], None]] = {}


def _conv_check(fn):
    CONVERSATION_CHECKS[fn.__name__.removeprefix("check_")] = fn
    return fn


def _ago(days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec="seconds")


def _turn(question="q", **fields) -> Turn:
    return Turn(question=question, answer=fields.pop("answer", "a"), **fields)


@_conv_check
def check_load_unknown_returns_none(store):
    _expect(store.load("nope", "u1") is None, "load of a conversation that does not exist must return None")


@_conv_check
def check_append_then_load_returns_turns_in_order(store):
    store.append("c1", "u1", _turn("first"))
    store.append("c1", "u1", _turn("second"))
    got = store.load("c1", "u1")
    _expect(got is not None, "load returned None after append")
    _expect([t.question for t in got.turns] == ["first", "second"], "turns must come back in the order they were appended")
    _expect(got.id == "c1" and got.user_id == "u1", "the conversation must carry its id and its user")
    _expect(all(t.created_at for t in got.turns), "a turn with no created_at must be stamped")


@_conv_check
def check_load_by_another_user_returns_none(store):
    store.append("c1", "u1", _turn())
    _expect(store.load("c1", "u2") is None, "another user must not read a conversation")


@_conv_check
def check_append_by_another_user_is_refused(store):
    store.append("c1", "u1", _turn("mine"))
    try:
        store.append("c1", "u2", _turn("theirs"))
    except ConversationNotFound:
        pass
    else:
        raise AssertionError("append by another user must raise ConversationNotFound")
    got = store.load("c1", "u1")
    _expect(got is not None and [t.question for t in got.turns] == ["mine"], "a refused append must change nothing")


@_conv_check
def check_list_shows_only_own_conversations_newest_first(store):
    store.append("new", "u1", _turn("fresh", created_at=_ago(1)))
    store.append("new", "u1", _turn("again", created_at=_ago(1)))
    store.append("old", "u1", _turn("x" * 200, created_at=_ago(2)))
    store.append("other", "u2", _turn("not yours"))
    got = store.list("u1")
    _expect([i.id for i in got] == ["new", "old"], "list must show the user's own conversations, newest first")
    _expect(got[0].title == "fresh" and got[0].turns == 2, "list must give the first question as title and the turn count")
    _expect(got[1].title == "x" * TITLE_LENGTH, f"a title is cut to {TITLE_LENGTH} characters")


@_conv_check
def check_delete_removes_only_the_owners_conversation(store):
    store.append("c1", "u1", _turn("gone"))
    store.append("c2", "u1", _turn("kept"))
    store.delete("c1", "u2")
    _expect(store.load("c1", "u1") is not None, "another user must not delete a conversation")
    store.delete("nope", "u1")
    store.delete("c1", "u1")
    _expect(store.load("c1", "u1") is None, "the owner's delete must remove the conversation")
    _expect(store.load("c2", "u1") is not None, "a delete must leave the user's other conversations")
    store.append("c1", "u2", _turn("new owner"))
    got = store.load("c1", "u2")
    _expect(got is not None and [t.question for t in got.turns] == ["new owner"],
            "a delete must remove the conversation's turns too, not only the conversation")


@_conv_check
def check_set_summary_is_returned_by_load(store):
    store.append("c1", "u1", _turn())
    store.set_summary("c1", "so far", 1)
    got = store.load("c1", "u1")
    _expect(got is not None and got.summary == "so far" and got.summary_upto == 1,
            "load must return the summary and the turn count it covers")


@_conv_check
def check_memories_are_per_user_and_oldest_first(store):
    store.add_memory("u1", Memory(text="one"))
    store.add_memory("u1", Memory(text="two"))
    store.add_memory("u2", Memory(text="theirs"))
    got = store.memories("u1")
    _expect([m.text for m in got] == ["one", "two"], "memories must be the user's own, oldest first")
    _expect(all(m.id for m in got) and len({m.id for m in got}) == 2, "the store must give each memory its own id")
    _expect([m.text for m in store.memories("u2")] == ["theirs"], "another user's memories must stay apart")


@_conv_check
def check_delete_memory_by_another_user_does_nothing(store):
    store.add_memory("u1", Memory(text="keep"))
    memory = store.memories("u1")[0]
    store.delete_memory("u2", memory.id)
    _expect(len(store.memories("u1")) == 1, "another user must not delete a memory")
    store.delete_memory("u1", memory.id)
    _expect(store.memories("u1") == [], "the owner's delete must remove the memory")


@_conv_check
def check_expire_deletes_old_conversations_and_counts_them(store):
    store.append("old", "u1", _turn("o", created_at=_ago(100)))
    store.append("fresh", "u1", _turn())
    store.append("long", "u1", _turn("started long ago", created_at=_ago(100)))
    store.append("long", "u1", _turn("still talking"))
    _expect(store.expire(30) == 1, "expire must return how many conversations it deleted")
    _expect(store.load("old", "u1") is None and store.load("fresh", "u1") is not None,
            "expire must delete only conversations whose newest turn is older than the limit")
    _expect(store.load("long", "u1") is not None, "a conversation is as old as its newest turn, not its first")
    _expect(store.expire(30) == 0, "a second expire has nothing left to delete")
    store.append("old", "u2", _turn("new owner"))
    got = store.load("old", "u2")
    _expect(got is not None and [t.question for t in got.turns] == ["new owner"],
            "expire must remove the conversation's turns too, not only the conversation")


@_conv_check
def check_expire_keeps_memories(store):
    store.add_memory("u1", Memory(text="stays", created_at=_ago(100)))
    store.expire(30)
    _expect([m.text for m in store.memories("u1")] == ["stays"], "expire must not delete memories")


@_conv_check
def check_delete_user_removes_only_that_users_data(store):
    store.append("c1", "u1", _turn("a"))
    store.append("c1", "u1", _turn("b"))
    store.append("c2", "u1", _turn("c"))
    store.add_memory("u1", Memory(text="mine"))
    store.append("c3", "u2", _turn("theirs"))
    store.add_memory("u2", Memory(text="theirs"))
    _expect(store.delete_user("u1") == {"conversations": 2, "memories": 1},
            "delete_user must return how many conversations and memories it removed")
    _expect(store.list("u1") == [] and store.memories("u1") == [],
            "delete_user must remove the user's conversations and memories")
    _expect(store.load("c3", "u2") is not None and [m.text for m in store.memories("u2")] == ["theirs"],
            "delete_user must leave other users' data alone")
    store.append("c1", "u2", _turn("new owner"))
    got = store.load("c1", "u2")
    _expect(got is not None and [t.question for t in got.turns] == ["new owner"],
            "delete_user must remove the conversations' turns too, not only the conversations")
    _expect(store.delete_user("u1") == {"conversations": 0, "memories": 0},
            "delete_user of a user with no data must return zeros")


@_conv_check
def check_a_turn_round_trips_every_field(store):
    turn = Turn(question="q", answer="a", rewrite="standalone q", source_ids=["s1", "s2"],
                trace_id="t1", created_at="2026-01-02T03:04:05+00:00")
    store.append("c1", "u1", turn)
    got = store.load("c1", "u1")
    _expect(got is not None and got.turns == [turn], "a turn must come back with every field unchanged")


def conversation_store_conformance(factory: Callable[[], ConversationStore]) -> None:
    """Run every check on a fresh store; raise AssertionError(f"{name}: {why}") on the first failure."""
    for name, check in CONVERSATION_CHECKS.items():
        try:
            check(factory())
        except AssertionError as e:
            raise AssertionError(f"{name}: {e}") from None
        except Exception as e:
            raise AssertionError(f"{name}: {type(e).__name__}: {e}") from None


TRACE_CHECKS: dict[str, Callable[[ConversationStore], None]] = {}


def _trace_check(fn):
    TRACE_CHECKS[fn.__name__.removeprefix("check_")] = fn
    return fn


def _record(trace_id="t1", user_id="u1", **fields) -> TraceRecord:
    return TraceRecord(trace_id=trace_id, user_id=user_id, conversation_id=fields.pop("conversation_id", "c1"),
                       question="q", **fields)


@_trace_check
def check_a_trace_round_trips_and_is_private_to_its_user(store):
    store.save_trace(_record(answer="a", label="cited", source_ids=["s1"], flags=["declined"], latency_ms=5))
    got = store.trace("t1", "u1")
    _expect(got is not None and (got.answer, got.label, got.source_ids, got.flags) == ("a", "cited", ["s1"], ["declined"]),
            "a saved trace must come back with its fields")
    _expect(got.created_at, "a trace with no created_at must be stamped")
    _expect(store.trace("t1", "u2") is None, "another user must not read the trace")
    _expect(store.trace("nope", "u1") is None, "an unknown trace must be None")


@_trace_check
def check_feedback_is_kept_only_for_the_owner(store):
    store.save_trace(_record())
    _expect(store.add_feedback("t1", "u2", Feedback(value="up")) is False, "another user's feedback must be refused")
    _expect(store.add_feedback("t1", "u1", Feedback(value="down")) is True, "the owner's feedback must be kept")
    _expect([f.value for f in store.trace("t1", "u1").feedback] == ["down"], "feedback must come back on the trace")


@_trace_check
def check_traces_are_newest_first_and_filtered(store):
    store.save_trace(_record("old", created_at=_ago(5)))
    store.save_trace(_record("new", created_at=_ago(1), flags=["low_grounding"]))
    _expect([r.trace_id for r in store.traces()] == ["new", "old"], "traces must be newest first")
    _expect([r.trace_id for r in store.traces(since=_ago(3))] == ["new"], "since must leave older traces out")
    _expect([r.trace_id for r in store.traces(flagged_only=True)] == ["new"], "flagged_only must keep flagged traces")


@_trace_check
def check_delete_user_removes_their_traces_and_feedback(store):
    store.append("c1", "u1", _turn())
    store.save_trace(_record())
    store.add_feedback("t1", "u1", Feedback(value="up"))
    store.save_trace(_record("t2", "u2", conversation_id="c2"))
    store.delete_user("u1")
    _expect(store.trace("t1") is None, "delete_user must remove the user's traces")
    _expect([r.trace_id for r in store.traces()] == ["t2"], "delete_user must leave other users' traces alone")
    store.save_trace(_record())
    _expect(store.trace("t1").feedback == [], "delete_user must remove the user's feedback too")


@_trace_check
def check_delete_removes_traces(store):
    store.append("c1", "u1", _turn())
    store.save_trace(_record())
    store.add_feedback("t1", "u1", Feedback(value="up"))
    store.save_trace(_record("t2", conversation_id="c2"))
    store.delete("c1", "u1")
    _expect(store.trace("t1") is None, "delete must remove the conversation's traces")
    _expect(store.trace("t2") is not None, "delete must leave other conversations' traces alone")
    store.save_trace(_record())
    _expect(store.trace("t1").feedback == [], "delete must remove the conversation's feedback too")


@_trace_check
def check_expire_removes_traces(store):
    store.append("old", "u1", Turn(question="q", answer="a", created_at=_ago(40)))
    store.save_trace(_record("t-old", conversation_id="old"))
    store.add_feedback("t-old", "u1", Feedback(value="up"))
    store.save_trace(_record("t-new", conversation_id="new"))
    store.expire(30)
    _expect(store.trace("t-old") is None, "expire must remove the traces of expired conversations")
    _expect(store.trace("t-new") is not None, "expire must keep traces of live conversations")


def trace_store_conformance(factory: Callable[[], ConversationStore]) -> None:
    """Run every trace check on a fresh store that is also a `TraceStore`; the first failure raises
    AssertionError(f"{name}: {why}")."""
    for name, check in TRACE_CHECKS.items():
        try:
            check(factory())
        except AssertionError as e:
            raise AssertionError(f"{name}: {e}") from None
        except Exception as e:
            raise AssertionError(f"{name}: {type(e).__name__}: {e}") from None
