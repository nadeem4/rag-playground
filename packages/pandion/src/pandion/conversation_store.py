"""The conversation store contract: where chats and memories live.

`ConversationStore` is a Stable contract. A store keeps conversations (turns and
a running summary) and a user's memories, and every one belongs to a `user_id`:
a user reads, lists, changes and deletes only their own, and `delete_user` removes all of them. `register_conversation_store`
adds a store by name, and `pandion.testing.conversation_store_conformance` checks
that it keeps the contract.

Times are UTC ISO 8601 strings. A store fills `created_at` only when it is empty.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import ClassVar, Protocol

from pydantic import BaseModel, field_validator

TITLE_LENGTH = 80


def utc_now() -> str:
    """The time a store stamps on what it keeps: UTC, ISO 8601, to the second."""
    return datetime.now(UTC).isoformat(timespec="seconds")


def _utc(value: str) -> str:
    """One UTC format for every stored time, so times sort as text."""
    if not value:
        return value
    when = datetime.fromisoformat(value)
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).isoformat(timespec="seconds")


class Turn(BaseModel):
    question: str
    answer: str
    #: The standalone question the turn was searched with.
    rewrite: str = ""
    source_ids: list[str] = []
    trace_id: str = ""
    created_at: str = ""

    @field_validator("created_at")
    @classmethod
    def _created_at_is_utc(cls, value: str) -> str:
        return _utc(value)


class Conversation(BaseModel):
    id: str
    user_id: str
    turns: list[Turn] = []
    #: A running summary of the turns before `summary_upto`.
    summary: str = ""
    summary_upto: int = 0
    created_at: str = ""
    updated_at: str = ""


class ConversationInfo(BaseModel):
    id: str
    #: The first question, cut to 80 characters.
    title: str
    turns: int
    updated_at: str


class Memory(BaseModel):
    #: The store makes the id.
    id: str = ""
    text: str
    created_at: str = ""


class ConversationNotFound(LookupError):
    """The conversation does not exist, or belongs to another user."""


class ConversationStore(Protocol):
    name: ClassVar[str]
    settings_model: ClassVar[type[BaseModel]]

    def load(self, conversation_id: str, user_id: str) -> Conversation | None: ...
    def append(self, conversation_id: str, user_id: str, turn: Turn) -> None: ...
    def set_summary(self, conversation_id: str, summary: str, upto_turn: int) -> None: ...
    def list(self, user_id: str) -> list[ConversationInfo]: ...
    def delete(self, conversation_id: str, user_id: str) -> None: ...
    def memories(self, user_id: str) -> list[Memory]:
        """The user's own memories, oldest first."""
        ...
    def add_memory(self, user_id: str, memory: Memory) -> None: ...
    def delete_memory(self, user_id: str, memory_id: str) -> None: ...
    def delete_user(self, user_id: str) -> dict[str, int]:
        """Remove all of the user's conversations (with their turns) and memories.
        Returns `{"conversations": n, "memories": m}`; an unknown user gives zeros."""
        ...
    def expire(self, older_than_days: int) -> int: ...


_STORES: dict[str, type] = {}


def register_conversation_store(cls: type) -> type:
    """Add a store by its `name`. A second store with the same name is refused."""
    old = _STORES.get(cls.name)
    if old is not None and old is not cls:
        raise ValueError(
            f"Two conversation stores are named '{cls.name}': one in {old.__module__} and one in {cls.__module__}. "
            "Rename one of them."
        )
    _STORES[cls.name] = cls
    return cls


def _load_builtin() -> None:
    import pandion.conversation_sql  # noqa: F401  (registers the sql store; imports no heavy library)


def conversation_store_names() -> tuple[str, ...]:
    _load_builtin()
    return tuple(sorted(_STORES))


def conversation_store_class(name: str) -> type:
    _load_builtin()
    return _STORES[name]


def get_conversation_store(name: str, settings: dict | None = None) -> ConversationStore:
    _load_builtin()
    cls = _STORES.get(name)
    if cls is None:
        known = ", ".join(sorted(_STORES))
        raise ValueError(f"There is no conversation store named '{name}'. The stores are: {known}.")
    return cls(cls.settings_model(**(settings or {})))
