from __future__ import annotations

from plugins import PLUGIN_MODULES


def test_registry_lists_every_plugin_with_its_contract(client):
    r = client.get("/api/registry")
    assert r.status_code == 200
    body = r.json()
    entries = [t for stage in body.values() for t in stage.values()]
    assert len(entries) == len(PLUGIN_MODULES) == 17
    for t in entries:
        for key in ("config_schema", "inputs", "output", "stackable", "learn"):
            assert key in t, (t["name"], key)
    assert body["clean"]["dedupe_blocks"]["stackable"] is True
    assert body["chunk"]["recursive_character"]["stackable"] is False


def test_registry_exports_each_plugins_learn_data(client):
    body = client.get("/api/registry").json()
    learn = body["chunk"]["recursive_character"]["learn"]
    assert set(learn) == {"_strategy", "chunk_size", "chunk_overlap"}
    assert learn["chunk_size"]["hint"] == (
        "This is the largest a chunk can be, counted in characters."
    )
    assert isinstance(learn["chunk_size"]["more"], list)
    assert body["parse"]["pdfium"]["learn"] == {}
