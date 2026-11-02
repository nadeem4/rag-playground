"""The conversation store conformance suite, run against a throwaway in-memory store."""

import itertools

import pytest

from pandion.conversation_store import Conversation, ConversationInfo, ConversationNotFound, Memory
from pandion.testing import CONVERSATION_CHECKS, conversation_store_conformance
from pandion.conversation_store import utc_now


class RefStore:
    """The reference: dicts, and every rule of the contract."""

    name = "ref"
    settings_model = object

    def __init__(self):
        self.convs: dict[str, Conversation] = {}
        self.mems: dict[str, list[Memory]] = {}
        self.ids = itertools.count(1)

    def load(self, conversation_id, user_id):
        conv = self.convs.get(conversation_id)
        return conv.model_copy(deep=True) if conv and conv.user_id == user_id else None

    def append(self, conversation_id, user_id, turn):
        conv = self.convs.get(conversation_id)
        if conv is not None and conv.user_id != user_id:
            raise ConversationNotFound(conversation_id)
        turn = turn.model_copy(update={"created_at": turn.created_at or utc_now()})
        if conv is None:
            conv = self.convs[conversation_id] = Conversation(
                id=conversation_id, user_id=user_id, created_at=turn.created_at)
        conv.turns.append(turn)
        conv.updated_at = max(conv.updated_at, turn.created_at)

    def set_summary(self, conversation_id, summary, upto_turn):
        self.convs[conversation_id].summary = summary
        self.convs[conversation_id].summary_upto = upto_turn

    def list(self, user_id):
        mine = [c for c in self.convs.values() if c.user_id == user_id]
        mine.sort(key=lambda c: c.updated_at, reverse=True)
        return [ConversationInfo(id=c.id, title=c.turns[0].question[:80], turns=len(c.turns),
                                 updated_at=c.updated_at) for c in mine]

    def delete(self, conversation_id, user_id):
        conv = self.convs.get(conversation_id)
        if conv and conv.user_id == user_id:
            del self.convs[conversation_id]

    def memories(self, user_id):
        return [m.model_copy() for m in self.mems.get(user_id, [])]

    def add_memory(self, user_id, memory):
        memory = memory.model_copy(update={"id": memory.id or f"m{next(self.ids)}",
                                           "created_at": memory.created_at or utc_now()})
        self.mems.setdefault(user_id, []).append(memory)

    def delete_memory(self, user_id, memory_id):
        self.mems[user_id] = [m for m in self.mems.get(user_id, []) if m.id != memory_id]

    def expire(self, older_than_days):
        from datetime import UTC, datetime, timedelta

        cutoff = (datetime.now(UTC) - timedelta(days=older_than_days)).isoformat()
        old = [cid for cid, c in self.convs.items() if c.updated_at < cutoff]
        for cid in old:
            del self.convs[cid]
        return len(old)


@pytest.mark.parametrize("name", list(CONVERSATION_CHECKS), ids=list(CONVERSATION_CHECKS))
def test_the_reference_store_passes_every_check(name):
    CONVERSATION_CHECKS[name](RefStore())


def test_the_reference_store_passes_the_whole_suite():
    conversation_store_conformance(RefStore)


def test_conformance_catches_a_store_that_shows_another_users_conversation():
    class Leaky(RefStore):
        def load(self, conversation_id, user_id):
            return super().load(conversation_id, self.convs[conversation_id].user_id) if conversation_id in self.convs else None

    with pytest.raises(AssertionError, match="load_by_another_user_returns_none"):
        conversation_store_conformance(Leaky)


def test_conformance_catches_a_store_that_lets_another_user_delete():
    class Leaky(RefStore):
        def delete(self, conversation_id, user_id):
            self.convs.pop(conversation_id, None)

    with pytest.raises(AssertionError, match="delete_removes_only_the_owners_conversation"):
        conversation_store_conformance(Leaky)


def test_conformance_catches_a_store_that_lists_everyones_conversations():
    class Leaky(RefStore):
        def list(self, user_id):
            return [i for u in {c.user_id for c in self.convs.values()} for i in super().list(u)]

    with pytest.raises(AssertionError, match="list_shows_only_own_conversations_newest_first"):
        conversation_store_conformance(Leaky)


def test_conformance_catches_a_store_that_drops_the_summary():
    class Leaky(RefStore):
        def set_summary(self, conversation_id, summary, upto_turn):
            pass

    with pytest.raises(AssertionError, match="set_summary_is_returned_by_load"):
        conversation_store_conformance(Leaky)


def test_conformance_catches_a_store_that_forgets_memories_on_expire():
    class Leaky(RefStore):
        def expire(self, older_than_days):
            self.mems.clear()
            return super().expire(older_than_days)

    with pytest.raises(AssertionError, match="expire_keeps_memories"):
        conversation_store_conformance(Leaky)


def test_conformance_names_the_failing_check_in_the_error():
    class Broken(RefStore):
        def load(self, conversation_id, user_id):
            raise RuntimeError("boom")

    with pytest.raises(AssertionError, match=r"^load_unknown_returns_none: RuntimeError: boom$"):
        conversation_store_conformance(Broken)


class KeepsTurns(RefStore):
    """Removes the conversation but leaves its turns behind for the next one with that id."""

    def __init__(self):
        super().__init__()
        self.orphans = {}

    def delete(self, conversation_id, user_id):
        conv = self.convs.get(conversation_id)
        if conv and conv.user_id == user_id:
            self.orphans[conversation_id] = conv.turns
            del self.convs[conversation_id]

    def expire(self, older_than_days):
        before = dict(self.convs)
        count = super().expire(older_than_days)
        for cid, conv in before.items():
            if cid not in self.convs:
                self.orphans[cid] = conv.turns
        return count

    def append(self, conversation_id, user_id, turn):
        fresh = conversation_id not in self.convs
        super().append(conversation_id, user_id, turn)
        if fresh and conversation_id in self.orphans:
            self.convs[conversation_id].turns[:0] = self.orphans.pop(conversation_id)


def test_conformance_catches_a_delete_that_keeps_the_turns():
    with pytest.raises(AssertionError, match="delete_removes_only_the_owners_conversation"):
        conversation_store_conformance(KeepsTurns)


def test_conformance_catches_an_expire_that_keeps_the_turns():
    class OnlyExpireLeaks(KeepsTurns):
        def delete(self, conversation_id, user_id):
            RefStore.delete(self, conversation_id, user_id)

    with pytest.raises(AssertionError, match="expire_deletes_old_conversations_and_counts_them"):
        conversation_store_conformance(OnlyExpireLeaks)


def test_conformance_catches_an_expire_that_ages_by_the_first_turn():
    class AgesByStart(RefStore):
        def expire(self, older_than_days):
            for c in self.convs.values():
                c.updated_at = c.created_at
            return super().expire(older_than_days)

    with pytest.raises(AssertionError, match="expire_deletes_old_conversations_and_counts_them"):
        conversation_store_conformance(AgesByStart)


def test_conformance_catches_a_list_in_insertion_order():
    class Unsorted(RefStore):
        def list(self, user_id):
            return [
                ConversationInfo(id=c.id, title=c.turns[0].question[:80], turns=len(c.turns), updated_at=c.updated_at)
                for c in reversed(list(self.convs.values())) if c.user_id == user_id]

    with pytest.raises(AssertionError, match="list_shows_only_own_conversations_newest_first"):
        conversation_store_conformance(Unsorted)


def test_conformance_catches_a_delete_that_removes_the_users_other_conversations():
    class DeletesAll(RefStore):
        def delete(self, conversation_id, user_id):
            for cid in [k for k, c in self.convs.items() if c.user_id == user_id and conversation_id in self.convs]:
                del self.convs[cid]

    with pytest.raises(AssertionError, match="delete_removes_only_the_owners_conversation"):
        conversation_store_conformance(DeletesAll)


def test_a_turn_time_is_normalised_to_one_utc_format():
    from pandion.conversation_store import Turn

    assert Turn(question="q", answer="a", created_at="2026-01-02T03:04:05Z").created_at == "2026-01-02T03:04:05+00:00"
    assert Turn(question="q", answer="a", created_at="2026-01-02T03:04:05+02:00").created_at == "2026-01-02T01:04:05+00:00"
    assert Turn(question="q", answer="a").created_at == ""
    with pytest.raises(ValueError):
        Turn(question="q", answer="a", created_at="yesterday")
