"""Storage: content-addressed store with a crash-safe commit protocol.

The invariant under test throughout: `meta.json` is written LAST and its
existence is the *sole* cache-hit signal. A process killed mid-write must never
leave a directory that `has()` reports as a hit.
"""

import pytest

from core.artifacts import Artifact, ArtifactType
from core.storage import Store


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "artifacts")


AID = "abcdef0123456789" + "f" * 48


def test_put_then_get_roundtrip(store):
    art = Artifact(id=AID, type=ArtifactType.CHUNK_SET, meta={"count": 3})
    store.put(art, {"chunks": [1, 2, 3]})
    assert store.has(AID)
    assert store.get_meta(AID).meta["count"] == 3
    assert store.load(AID, ArtifactType.CHUNK_SET) == {"chunks": [1, 2, 3]}


def test_path_is_sharded_and_short(store):
    p = store.path_for(AID)
    assert p.parts[-3:] == ("ab", "cd", AID[:16])


def test_missing_artifact_is_not_a_hit(store):
    assert store.has(AID) is False


def test_meta_json_is_the_sole_cache_hit_signal(store):
    """A payload without meta.json is a half-written entry, not a hit."""
    d = store.path_for(AID)
    d.mkdir(parents=True)
    (d / "payload.json").write_text('{"chunks": []}', encoding="utf-8")
    assert store.has(AID) is False


def test_leftover_tmp_dir_is_not_a_hit(store):
    store.root.mkdir(parents=True, exist_ok=True)
    (store.root / ".tmp-deadbeef").mkdir()
    assert store.has(AID) is False


def test_open_writer_commits_only_on_clean_exit(store):
    with store.open_writer(AID) as d:
        (d / "payload.json").write_text('{"ok": true}', encoding="utf-8")
    assert (store.path_for(AID) / "payload.json").exists()


def test_open_writer_leaves_nothing_on_exception(store):
    with pytest.raises(RuntimeError):
        with store.open_writer(AID) as d:
            (d / "payload.json").write_text("partial", encoding="utf-8")
            raise RuntimeError("boom")
    assert store.has(AID) is False
    assert not store.path_for(AID).exists()
    assert list(store.root.glob(".tmp-*")) == []


def test_directory_payload_roundtrip(store):
    art = Artifact(id=AID, type=ArtifactType.INDEX, meta={"backends": ["dense"]})

    def build(d):
        (d / "table.bin").write_bytes(b"\x00\x01")

    store.put(art, build)
    handle = store.load(AID, ArtifactType.INDEX)
    assert (handle / "table.bin").read_bytes() == b"\x00\x01"


def test_put_replaces_an_existing_entry(store):
    art = Artifact(id=AID, type=ArtifactType.CHUNK_SET, meta={"n": 1})
    store.put(art, {"v": 1})
    store.put(Artifact(id=AID, type=ArtifactType.CHUNK_SET, meta={"n": 2}), {"v": 2})
    assert store.load(AID, ArtifactType.CHUNK_SET) == {"v": 2}
    assert store.get_meta(AID).meta == {"n": 2}
    assert not any(p.name.startswith(".tmp-") for p in store.path_for(AID).iterdir())


def test_replace_that_cannot_remove_the_old_entry_leaves_no_stale_hit(
    store, monkeypatch
):
    """Windows: a held handle can stop the old directory being deleted. The old
    entry must be uncommitted first, and the new one must not be nested in it."""
    store.put(Artifact(id=AID, type=ArtifactType.CHUNK_SET, meta={}), {"v": 1})
    monkeypatch.setattr("core.storage.shutil.rmtree", lambda *a, **k: None)
    with pytest.raises(OSError):
        store.put(Artifact(id=AID, type=ArtifactType.CHUNK_SET, meta={}), {"v": 2})
    assert store.has(AID) is False
    assert not any(p.name.startswith(".tmp-") for p in store.path_for(AID).iterdir())


def test_clear_removes_everything(store):
    store.put(Artifact(id=AID, type=ArtifactType.CHUNK_SET, meta={}), {"a": 1})
    store.clear()
    assert store.has(AID) is False
