"""The `sql` conversation store: any database SQLAlchemy reaches.

Set `url` to a SQLAlchemy connection url (SQLite is the default; Postgres, MySQL
and SQL Server work the same way). Install it with `pip install "pandion[sql]"`.
The tables are made on first use. A `pandion_schema` row records the format, and a
store written by a newer pandion is refused. SQLAlchemy is imported only inside
functions, and the url is a secret: it never appears in a repr or an error.
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

from pydantic import BaseModel, SecretStr

from pandion.conversation_store import (
    TITLE_LENGTH, Conversation, ConversationInfo, ConversationNotFound, Memory, Turn, register_conversation_store,
    utc_now,
)
from pandion.errors import FormatTooNew, require

_STEP = "The sql conversation store"
_SCHEMA_VERSION = 1
_RETRIES = 5


class SqlSettings(BaseModel):
    url: SecretStr = SecretStr("sqlite:///pandion_conversations.db")


@register_conversation_store
class SqlStore:
    name: ClassVar[str] = "sql"
    settings_model: ClassVar[type[BaseModel]] = SqlSettings

    def __init__(self, settings: SqlSettings):
        self.settings = settings
        self._lock = threading.Lock()
        self._engine: Any = None
        self._t: dict[str, Any] = {}

    def __repr__(self) -> str:
        return "SqlStore(url=**********)"

    # -- setup -------------------------------------------------------------

    def _scrub(self, text: str) -> str:
        url = self.settings.url.get_secret_value()
        text = text.replace(url, "<url>")
        try:
            password = require("sqlalchemy.engine", extra="sql", step=_STEP).make_url(url).password
        except Exception:  # noqa: BLE001  (an unreadable url has no password to hide)
            password = None
        return text.replace(password, "***") if password else text

    def check(self) -> None:
        """Open the database, refuse a newer format, and make what is missing."""
        if self._engine is not None:
            return
        with self._lock:
            if self._engine is not None:
                return
            sa = require("sqlalchemy", extra="sql", step=_STEP)
            try:
                engine = sa.create_engine(self.settings.url.get_secret_value())
                tables = self._make_tables(sa)
                self._prepare(sa, engine, tables)
            except (FormatTooNew, ImportError):
                raise
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"{_STEP} could not open its database: {self._scrub(str(exc))}") from None
            self._t, self._engine = tables, engine

    @staticmethod
    def _make_tables(sa) -> dict[str, Any]:
        meta = sa.MetaData()
        text = sa.String(255)
        return {
            "meta": meta,
            "schema": sa.Table("pandion_schema", meta,
                               sa.Column("key", text, primary_key=True), sa.Column("value", sa.Integer, nullable=False)),
            "conversations": sa.Table(
                "conversations", meta,
                sa.Column("id", text, primary_key=True), sa.Column("user_id", text, nullable=False, index=True),
                sa.Column("title", sa.Text, nullable=False), sa.Column("summary", sa.Text, nullable=False),
                sa.Column("summary_upto", sa.Integer, nullable=False),
                sa.Column("created_at", text, nullable=False), sa.Column("updated_at", text, nullable=False, index=True)),
            "turns": sa.Table(
                "turns", meta,
                sa.Column("conversation_id", text, primary_key=True), sa.Column("position", sa.Integer, primary_key=True),
                sa.Column("data", sa.Text, nullable=False)),
            "memories": sa.Table(
                "memories", meta,
                sa.Column("seq", sa.Integer, primary_key=True, autoincrement=True),
                sa.Column("id", text, nullable=False, unique=True), sa.Column("user_id", text, nullable=False, index=True),
                sa.Column("text", sa.Text, nullable=False), sa.Column("created_at", text, nullable=False)),
        }

    @staticmethod
    def _prepare(sa, engine, t) -> None:
        schema = t["schema"]
        inspector = sa.inspect(engine)
        if inspector.has_table("pandion_schema"):
            with engine.connect() as conn:
                found = conn.execute(sa.select(schema.c.value).where(schema.c.key == "conversations")).scalar()
            if found is not None and found > _SCHEMA_VERSION:
                raise FormatTooNew(
                    f"This conversation store was written in format {found}, which this pandion does not read. "
                    "Please upgrade pandion."
                )
        t["meta"].create_all(engine)
        with engine.begin() as conn:
            if conn.execute(sa.select(schema.c.value).where(schema.c.key == "conversations")).first() is None:
                conn.execute(sa.insert(schema).values(key="conversations", value=_SCHEMA_VERSION))

    def _sa(self):
        self.check()
        return require("sqlalchemy", extra="sql", step=_STEP)

    # -- conversations -----------------------------------------------------

    def load(self, conversation_id: str, user_id: str) -> Conversation | None:
        sa = self._sa()
        c, turns = self._t["conversations"], self._t["turns"]
        with self._engine.connect() as conn:
            row = conn.execute(sa.select(c).where(c.c.id == conversation_id, c.c.user_id == user_id)).first()
            if row is None:
                return None
            data = conn.execute(
                sa.select(turns.c.data).where(turns.c.conversation_id == conversation_id).order_by(turns.c.position)
            ).scalars().all()
        return Conversation(
            id=row.id, user_id=row.user_id, turns=[Turn.model_validate(json.loads(d)) for d in data],
            summary=row.summary, summary_upto=row.summary_upto, created_at=row.created_at, updated_at=row.updated_at,
        )

    def append(self, conversation_id: str, user_id: str, turn: Turn) -> None:
        sa = self._sa()
        turn = turn.model_copy(update={"created_at": turn.created_at or utc_now()})
        for attempt in range(_RETRIES):
            try:
                self._append_once(sa, conversation_id, user_id, turn)
                return
            except sa.exc.IntegrityError:
                # Two servers took the same position, or made the conversation together; try again.
                if attempt == _RETRIES - 1:
                    raise

    def _append_once(self, sa, conversation_id: str, user_id: str, turn: Turn) -> None:
        c, turns = self._t["conversations"], self._t["turns"]
        with self._engine.begin() as conn:
            row = conn.execute(sa.select(c.c.user_id, c.c.updated_at).where(c.c.id == conversation_id)).first()
            if row is None:
                position = 0
                conn.execute(sa.insert(c).values(
                    id=conversation_id, user_id=user_id, title=turn.question[:TITLE_LENGTH], summary="",
                    summary_upto=0, created_at=turn.created_at, updated_at=turn.created_at))
            elif row.user_id != user_id:
                raise ConversationNotFound(f"There is no conversation '{conversation_id}' for this user.")
            else:
                position = conn.execute(
                    sa.select(sa.func.coalesce(sa.func.max(turns.c.position), -1) + 1)
                    .where(turns.c.conversation_id == conversation_id)).scalar_one()
                conn.execute(sa.update(c).where(c.c.id == conversation_id)
                             .values(updated_at=max(row.updated_at, turn.created_at)))
            conn.execute(sa.insert(turns).values(
                conversation_id=conversation_id, position=position, data=turn.model_dump_json()))

    def set_summary(self, conversation_id: str, summary: str, upto_turn: int) -> None:
        sa = self._sa()
        c = self._t["conversations"]
        with self._engine.begin() as conn:
            done = conn.execute(sa.update(c).where(c.c.id == conversation_id)
                                .values(summary=summary, summary_upto=upto_turn))
        if done.rowcount == 0:
            raise ConversationNotFound(f"There is no conversation '{conversation_id}'.")

    def list(self, user_id: str) -> list[ConversationInfo]:
        sa = self._sa()
        c, turns = self._t["conversations"], self._t["turns"]
        count = (sa.select(sa.func.count()).where(turns.c.conversation_id == c.c.id).scalar_subquery())
        with self._engine.connect() as conn:
            rows = conn.execute(
                sa.select(c.c.id, c.c.title, c.c.updated_at, count.label("n")).where(c.c.user_id == user_id)
                .order_by(c.c.updated_at.desc(), c.c.created_at.desc())).all()
        return [ConversationInfo(id=r.id, title=r.title, turns=r.n, updated_at=r.updated_at) for r in rows]

    def delete(self, conversation_id: str, user_id: str) -> None:
        sa = self._sa()
        c, turns = self._t["conversations"], self._t["turns"]
        with self._engine.begin() as conn:
            owned = conn.execute(sa.select(c.c.id).where(c.c.id == conversation_id, c.c.user_id == user_id)).first()
            if owned is None:
                return
            conn.execute(sa.delete(turns).where(turns.c.conversation_id == conversation_id))
            conn.execute(sa.delete(c).where(c.c.id == conversation_id))

    # -- memories ----------------------------------------------------------

    def memories(self, user_id: str) -> list[Memory]:
        sa = self._sa()
        m = self._t["memories"]
        with self._engine.connect() as conn:
            rows = conn.execute(sa.select(m).where(m.c.user_id == user_id).order_by(m.c.seq)).all()
        return [Memory(id=r.id, text=r.text, created_at=r.created_at) for r in rows]

    def add_memory(self, user_id: str, memory: Memory) -> None:
        sa = self._sa()
        with self._engine.begin() as conn:
            conn.execute(sa.insert(self._t["memories"]).values(
                id=memory.id or uuid.uuid4().hex, user_id=user_id, text=memory.text,
                created_at=memory.created_at or utc_now()))

    def delete_memory(self, user_id: str, memory_id: str) -> None:
        sa = self._sa()
        m = self._t["memories"]
        with self._engine.begin() as conn:
            conn.execute(sa.delete(m).where(m.c.id == memory_id, m.c.user_id == user_id))

    # -- expiry ------------------------------------------------------------

    def expire(self, older_than_days: int) -> int:
        """Delete conversations whose newest turn is older than the limit. Memories stay."""
        sa = self._sa()
        c, turns = self._t["conversations"], self._t["turns"]
        cutoff = (datetime.now(UTC) - timedelta(days=older_than_days)).isoformat(timespec="seconds")
        with self._engine.begin() as conn:
            old = conn.execute(sa.select(c.c.id).where(c.c.updated_at < cutoff)).scalars().all()
            for chunk in range(0, len(old), 500):
                ids = old[chunk:chunk + 500]
                conn.execute(sa.delete(turns).where(turns.c.conversation_id.in_(ids)))
                conn.execute(sa.delete(c).where(c.c.id.in_(ids)))
        return len(old)
