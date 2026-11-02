"""The conversation store contract and its registry."""

import pytest

from pandion.conversation_store import (
    ConversationStore, Turn, conversation_store_names, get_conversation_store, register_conversation_store,
)


def test_turn_defaults_and_json_round_trip():
    turn = Turn(question="q", answer="a")
    assert turn.source_ids == []
    assert turn.rewrite == "" and turn.trace_id == "" and turn.created_at == ""
    assert Turn.model_validate_json(turn.model_dump_json()) == turn


def test_registering_two_stores_with_one_name_is_refused():
    class A:
        name = "twin_store_test"
        settings_model = object

    class B:
        name = "twin_store_test"
        settings_model = object

    B.__module__ = "other_module"
    register_conversation_store(A)
    with pytest.raises(ValueError) as err:
        register_conversation_store(B)
    assert A.__module__ in str(err.value) and "other_module" in str(err.value)


def test_an_unknown_store_names_the_choices():
    with pytest.raises(ValueError, match="sql"):
        get_conversation_store("nope")


def test_the_contract_words_are_exported_from_extend():
    from pandion import extend

    for word in ("Turn", "Conversation", "ConversationInfo", "Memory", "ConversationStore",
                 "ConversationNotFound", "register_conversation_store"):
        assert word in extend.__all__ and hasattr(extend, word)


def test_plugin_listing_has_a_conversation_store_row():
    from pandion.plugins import plugin_listing

    rows = [r for r in plugin_listing() if r["kind"] == "conversation store"]
    assert {"kind": "conversation store", "name": "sql", "module": "pandion.conversation_sql", "level": "stable"} in rows
    assert "sql" in conversation_store_names()
    assert ConversationStore is not None
