"""The SQL conversation store, on SQLite files."""

import itertools
import threading

import pytest

from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.conversation_store import Turn, get_conversation_store
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
