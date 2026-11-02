"""Serve builds its conversation store from PANDION_CONVERSATIONS_URL, never from a url in code."""

from apihelpers import settings
from pandion.extend import Turn
from pandion_api.serve import default_store


def test_serve_builds_its_store_from_the_environment_url(tmp_path, monkeypatch):
    db = tmp_path / "from_env.db"
    monkeypatch.setenv("PANDION_CONVERSATIONS_URL", f"sqlite:///{db.as_posix()}")
    store = default_store(settings(tmp_path))
    store.append("c1", "u1", Turn(question="q", answer="a"))
    assert db.exists() and not (tmp_path / "data" / "conversations.db").exists()
    assert "from_env" not in repr(store)


def test_without_the_variable_serve_uses_a_file_in_the_data_folder(tmp_path, monkeypatch):
    monkeypatch.delenv("PANDION_CONVERSATIONS_URL", raising=False)
    store = default_store(settings(tmp_path))
    store.append("c1", "u1", Turn(question="q", answer="a"))
    assert (tmp_path / "data" / "conversations.db").exists()
