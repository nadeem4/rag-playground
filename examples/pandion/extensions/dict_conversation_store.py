"""dict: a conversation store that keeps everything in Python dicts.

It lives as long as the process, so it suits tests and demos, not a server that
restarts. It shows what the ConversationStore contract asks of a store;
`conversation_store_conformance` proves it. Swap the dicts for Redis, DynamoDB or
any database and the rules stay the same.
"""

import itertools
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel

from pandion.extend import Conversation, ConversationInfo, ConversationNotFound, Memory, Turn, register_conversation_store


class DictSettings(BaseModel):
    pass


@register_conversation_store
class DictStore:
    name = "dict"
    settings_model = DictSettings

    def __init__(self, settings: DictSettings):
        self.conversations: dict[str, Conversation] = {}
        self.kept: dict[str, list[Memory]] = {}
        self.ids = itertools.count(1)

    def _now(self) -> str:
        return datetime.now(UTC).isoformat(timespec="seconds")

    def load(self, conversation_id, user_id):
        conv = self.conversations.get(conversation_id)
        # Ownership: another user sees a conversation as missing.
        return conv.model_copy(deep=True) if conv and conv.user_id == user_id else None

    def append(self, conversation_id, user_id, turn):
        conv = self.conversations.get(conversation_id)
        if conv is not None and conv.user_id != user_id:
            raise ConversationNotFound(conversation_id)  # appending to someone else's chat is refused
        turn = turn.model_copy(update={"created_at": turn.created_at or self._now()})  # fill the time only when empty
        if conv is None:
            conv = self.conversations[conversation_id] = Conversation(id=conversation_id, user_id=user_id, created_at=turn.created_at)
        conv.turns.append(turn)  # turns keep the order they arrive in
        conv.updated_at = max(conv.updated_at, turn.created_at)  # a conversation is as new as its newest turn

    def set_summary(self, conversation_id, summary, upto_turn):
        if conversation_id not in self.conversations:
            raise ConversationNotFound(conversation_id)
        self.conversations[conversation_id].summary = summary
        self.conversations[conversation_id].summary_upto = upto_turn

    def list(self, user_id):
        mine = sorted((c for c in self.conversations.values() if c.user_id == user_id), key=lambda c: c.updated_at, reverse=True)
        return [  # only the user's own, newest first, titled by the first question cut to 80 characters
            ConversationInfo(id=c.id, title=c.turns[0].question[:80], turns=len(c.turns), updated_at=c.updated_at) for c in mine
        ]

    def delete(self, conversation_id, user_id):
        conv = self.conversations.get(conversation_id)
        if conv is not None and conv.user_id == user_id:  # anyone else's delete does nothing
            del self.conversations[conversation_id]

    def memories(self, user_id):
        return [m.model_copy() for m in self.kept.get(user_id, [])]  # oldest first, as added

    def add_memory(self, user_id, memory):
        memory = memory.model_copy(update={"id": memory.id or f"m{next(self.ids)}", "created_at": memory.created_at or self._now()})
        self.kept.setdefault(user_id, []).append(memory)  # the store makes the id

    def delete_memory(self, user_id, memory_id):
        self.kept[user_id] = [m for m in self.kept.get(user_id, []) if m.id != memory_id]

    def delete_user(self, user_id):
        mine = [cid for cid, c in self.conversations.items() if c.user_id == user_id]
        for cid in mine:
            del self.conversations[cid]  # the turns live inside the conversation, so they go too
        kept = self.kept.pop(user_id, [])
        return {"conversations": len(mine), "memories": len(kept)}  # unknown user: zeros

    def expire(self, older_than_days):
        cutoff = (datetime.now(UTC) - timedelta(days=older_than_days)).isoformat(timespec="seconds")
        old = [cid for cid, c in self.conversations.items() if c.updated_at < cutoff]
        for cid in old:
            del self.conversations[cid]  # memories stay: they go only when the user deletes one
        return len(old)
