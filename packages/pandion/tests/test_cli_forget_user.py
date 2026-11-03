"""pandion forget-user removes one user's conversations and memories."""

import pytest

from pandion import cli
from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.conversation_store import Memory, Turn

VAR = "PANDION_TEST_CONV_URL"


@pytest.fixture
def db(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'c.db').as_posix()}"
    monkeypatch.setenv(VAR, url)
    store = SqlStore(SqlSettings(url=url))
    for cid in ("c1", "c2", "c3"):
        store.append(cid, "alice", Turn(question="q", answer="a"))
    store.add_memory("alice", Memory(text="one"))
    store.add_memory("alice", Memory(text="two"))
    store.append("b1", "bob", Turn(question="q", answer="a"))
    return store


def test_forget_user_prints_counts_and_exits_0(db, capsys):
    code = cli.main(["forget-user", "alice", "--url-env", VAR, "--yes"])
    out = capsys.readouterr().out
    assert code == 0 and "Deleted 3 conversations and 2 memories for alice." in out
    assert db.list("alice") == [] and len(db.list("bob")) == 1


def test_forget_user_without_yes_changes_nothing(db, capsys):
    code = cli.main(["forget-user", "alice", "--url-env", VAR])
    out = capsys.readouterr()
    assert code == 1 and "--yes" in out.err + out.out and "alice" in out.err + out.out
    assert len(db.list("alice")) == 3 and len(db.memories("alice")) == 2


def test_forget_user_unknown_user_reports_zeros(db, capsys):
    code = cli.main(["forget-user", "nobody", "--url-env", VAR, "--yes"])
    assert code == 0 and "Deleted 0 conversations and 0 memories for nobody." in capsys.readouterr().out


def test_forget_user_prints_the_backups_sentence(db, capsys):
    cli.main(["forget-user", "alice", "--url-env", VAR, "--yes"])
    out = capsys.readouterr().out
    assert "Backups" in out and "model providers" in out


def test_forget_user_with_sql_and_no_url_env_is_refused_and_makes_no_file(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code = cli.main(["forget-user", "alice", "--yes"])
    assert code == 2 and "--url-env" in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == []


def test_forget_user_with_an_unset_variable_exits_2_naming_it(monkeypatch, capsys):
    monkeypatch.delenv("PANDION_TEST_UNSET", raising=False)
    code = cli.main(["forget-user", "alice", "--url-env", "PANDION_TEST_UNSET", "--yes"])
    assert code == 2 and "PANDION_TEST_UNSET" in capsys.readouterr().err
