"""The SQL conversation store, on SQLite files."""

import itertools
import threading

import pytest

from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.conversation_store import Memory, Turn, get_conversation_store
from pandion.errors import FormatTooNew, MissingExtra
from pandion.testing import conversation_store_conformance


def sqlite_url(path) -> str:
    return f"sqlite:///{path.as_posix()}"


def test_the_sql_store_passes_the_conformance_suite(tmp_path):
    count = itertools.count()
    conversation_store_conformance(
        lambda: SqlStore(SqlSettings(url=sqlite_url(tmp_path / f"c{next(count)}.db"))))


def test_two_stores_on_one_file_share_data(tmp_path):
    url = sqlite_url(tmp_path / "shared.db")
    first, second = SqlStore(SqlSettings(url=url)), SqlStore(SqlSettings(url=url))
    first.append("c1", "u1", Turn(question="q", answer="a"))
    got = second.load("c1", "u1")
    assert got is not None and [t.question for t in got.turns] == ["q"]


def test_a_first_use_creates_the_tables_and_the_schema_row(tmp_path):
    import sqlalchemy as sa

    url = sqlite_url(tmp_path / "new.db")
    store = SqlStore(SqlSettings(url=url))
    assert store.list("u1") == []
    engine = sa.create_engine(url)
    with engine.connect() as conn:
        tables = set(sa.inspect(conn).get_table_names())
        version = conn.execute(sa.text("select value from pandion_schema where key = 'conversations'")).scalar_one()
    engine.dispose()
    assert {"conversations", "turns", "memories", "pandion_schema"} <= tables
    assert int(version) == 1


def test_a_newer_schema_is_refused(tmp_path):
    import sqlalchemy as sa

    url = sqlite_url(tmp_path / "new.db")
    SqlStore(SqlSettings(url=url)).list("u1")
    engine = sa.create_engine(url)
    with engine.begin() as conn:
        conn.execute(sa.text("update pandion_schema set value = 99 where key = 'conversations'"))
    engine.dispose()
    with pytest.raises(FormatTooNew, match="upgrade pandion"):
        SqlStore(SqlSettings(url=url)).load("c1", "u1")


def test_the_url_never_prints(tmp_path):
    url = "postgresql://u:secret@h/db"
    settings = SqlSettings(url=url)
    assert "secret" not in repr(settings) and "secret" not in repr(SqlStore(settings))
    for bad in (url, "postgresql+nodriver://u:secret@h/db", "u:secret@h", "sqlite://u:secret@/no/such/dir/x.db"):
        with pytest.raises(Exception) as err:
            SqlStore(SqlSettings(url=bad)).list("u1")
        assert "secret" not in str(err.value)
        assert "secret" not in repr(err.value)


def test_a_missing_sqlalchemy_names_the_extra(monkeypatch, tmp_path):
    def missing(module, *, extra, step):
        raise MissingExtra(f'{step} needs {module}. Install it with: pip install "pandion[{extra}]"')

    monkeypatch.setattr("pandion.conversation_sql.require", missing)
    with pytest.raises(MissingExtra, match=r"pandion\[sql\]"):
        SqlStore(SqlSettings(url=sqlite_url(tmp_path / "x.db"))).list("u1")


def test_concurrent_appends_keep_every_turn(tmp_path):
    url = sqlite_url(tmp_path / "busy.db")
    store = SqlStore(SqlSettings(url=url))
    store.list("u1")
    errors = []

    def work(name):
        try:
            for i in range(10):
                store.append("c1", "u1", Turn(question=f"{name}{i}", answer="a"))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(n,)) for n in "ab"]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    got = store.load("c1", "u1")
    assert len(got.turns) == 20
    for name in "ab":  # each thread's own turns stay in the order it sent them
        mine = [t.question for t in got.turns if t.question.startswith(name)]
        assert mine == [f"{name}{i}" for i in range(10)]


def test_the_store_is_found_by_name(tmp_path):
    store = get_conversation_store("sql", {"url": sqlite_url(tmp_path / "n.db")})
    assert isinstance(store, SqlStore)


def test_a_lost_race_for_a_position_is_retried_and_positions_stay_consecutive(tmp_path, monkeypatch):
    import sqlalchemy as sa

    store = SqlStore(SqlSettings(url=sqlite_url(tmp_path / "race.db")))
    store.append("c1", "u1", Turn(question="first", answer="a"))
    real, calls = store._append_once, []

    def lose_once(sa_mod, conversation_id, user_id, turn):
        calls.append(turn.question)
        if len(calls) == 1:  # another server wins the position, and this attempt is rolled back
            real(sa_mod, conversation_id, user_id, Turn(question="other server", answer="a"))
            raise sa.exc.IntegrityError("insert", {}, Exception("duplicate position"))
        real(sa_mod, conversation_id, user_id, turn)

    monkeypatch.setattr(store, "_append_once", lose_once)
    store.append("c1", "u1", Turn(question="mine", answer="a"))
    assert calls == ["mine", "mine"]
    assert [t.question for t in store.load("c1", "u1").turns] == ["first", "other server", "mine"]
    engine = sa.create_engine(sqlite_url(tmp_path / "race.db"))
    with engine.connect() as conn:
        positions = conn.execute(sa.text("select position from turns order by position")).scalars().all()
    engine.dispose()
    assert positions == [0, 1, 2]


def test_two_servers_starting_together_do_not_fail_on_the_schema_row(tmp_path, monkeypatch):
    import sqlalchemy as sa

    url = sqlite_url(tmp_path / "start.db")
    SqlStore(SqlSettings(url=url)).list("u1")  # the first server made the schema row
    real_first, seen = sa.engine.CursorResult.first, []

    def first_misses_once(self):
        if not seen:  # the second server read before the first one wrote
            seen.append(1)
            self.close()
            return None
        return real_first(self)

    monkeypatch.setattr(sa.engine.CursorResult, "first", first_misses_once)
    assert SqlStore(SqlSettings(url=url)).list("u1") == []
    assert seen


def test_times_in_any_offset_sort_as_one_utc_format(tmp_path):
    store = SqlStore(SqlSettings(url=sqlite_url(tmp_path / "t.db")))
    store.append("a", "u1", Turn(question="later", answer="a", created_at="2026-01-02T03:00:00Z"))
    store.append("b", "u1", Turn(question="earlier", answer="a", created_at="2026-01-02T04:00:00+02:00"))
    assert [i.id for i in store.list("u1")] == ["a", "b"]
    assert store.load("b", "u1").turns[0].created_at == "2026-01-02T02:00:00+00:00"


def test_delete_user_removes_conversations_turns_and_memories_and_returns_counts(tmp_path):
    store = SqlStore(SqlSettings(url=sqlite_url(tmp_path / "d.db")))
    store.append("c1", "u1", Turn(question="a", answer="b"))
    store.append("c1", "u1", Turn(question="c", answer="d"))
    store.append("c2", "u1", Turn(question="e", answer="f"))
    store.add_memory("u1", Memory(text="one"))
    store.add_memory("u1", Memory(text="two"))
    assert store.delete_user("u1") == {"conversations": 2, "memories": 2}
    assert store.list("u1") == [] and store.memories("u1") == []
    store.append("c1", "u2", Turn(question="new", answer="x"))
    assert [t.question for t in store.load("c1", "u2").turns] == ["new"]  # no turns left behind


def test_delete_user_leaves_other_users_alone(tmp_path):
    store = SqlStore(SqlSettings(url=sqlite_url(tmp_path / "d.db")))
    store.append("c1", "u1", Turn(question="a", answer="b"))
    store.append("c2", "u2", Turn(question="c", answer="d"))
    store.add_memory("u2", Memory(text="theirs"))
    store.delete_user("u1")
    assert store.load("c2", "u2") is not None and [m.text for m in store.memories("u2")] == ["theirs"]


def test_a_second_delete_user_returns_zeros(tmp_path):
    store = SqlStore(SqlSettings(url=sqlite_url(tmp_path / "d.db")))
    store.append("c1", "u1", Turn(question="a", answer="b"))
    store.delete_user("u1")
    assert store.delete_user("u1") == {"conversations": 0, "memories": 0}
    assert store.delete_user("nobody") == {"conversations": 0, "memories": 0}


def test_a_failure_in_the_middle_of_delete_user_deletes_nothing(tmp_path):
    store = SqlStore(SqlSettings(url=sqlite_url(tmp_path / "d.db")))
    store.append("c1", "u1", Turn(question="a", answer="b"))
    store.add_memory("u1", Memory(text="one"))
    store.check()
    from sqlalchemy import event

    def boom(conn, cursor, statement, *rest):
        if statement.startswith("DELETE FROM memories"):
            raise RuntimeError("disk gone")

    event.listen(store._engine, "before_cursor_execute", boom)
    with pytest.raises(Exception):
        store.delete_user("u1")
    event.remove(store._engine, "before_cursor_execute", boom)
    assert store.load("c1", "u1") is not None and len(store.memories("u1")) == 1


def test_url_env_reads_the_url_from_the_variable(tmp_path, monkeypatch):
    monkeypatch.setenv("MY_CONV_URL", sqlite_url(tmp_path / "env.db"))
    store = SqlStore(SqlSettings(url_env="MY_CONV_URL"))
    store.append("c1", "u1", Turn(question="q", answer="a"))
    assert (tmp_path / "env.db").exists()


def test_a_missing_variable_is_named_and_its_value_never_printed(monkeypatch):
    monkeypatch.delenv("NOT_SET_CONV_URL", raising=False)
    store = SqlStore(SqlSettings(url_env="NOT_SET_CONV_URL"))
    with pytest.raises(ValueError, match="NOT_SET_CONV_URL"):
        store.check()


def test_url_env_with_a_url_set_too_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("MY_CONV_URL", sqlite_url(tmp_path / "env.db"))
    with pytest.raises(ValueError, match="url_env"):
        SqlSettings(url=sqlite_url(tmp_path / "x.db"), url_env="MY_CONV_URL")
