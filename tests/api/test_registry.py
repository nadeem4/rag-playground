from __future__ import annotations

from plugins import PLUGIN_MODULES


def test_registry_lists_every_plugin_with_its_contract(client):
    r = client.get("/api/registry")
    assert r.status_code == 200
    body = r.json()
    entries = [t for stage in body.values() for t in stage.values()]
    assert len(entries) == len(PLUGIN_MODULES) == 23
    for t in entries:
        for key in ("config_schema", "inputs", "output", "stackable", "learn"):
            assert key in t, (t["name"], key)
    assert body["clean"]["dedupe_blocks"]["stackable"] is True
    assert body["chunk"]["recursive_character"]["stackable"] is False


def test_registry_exports_each_plugins_learn_data(client):
    body = client.get("/api/registry").json()
    learn = body["chunk"]["recursive_character"]["learn"]
    assert set(learn) == {"_strategy", "chunk_size", "chunk_overlap", "heading_context"}
    assert learn["chunk_size"]["hint"] == (
        "This is the largest a chunk can be, counted in characters."
    )
    assert isinstance(learn["chunk_size"]["more"], list)
    assert body["parse"]["pdfium"]["learn"] == {}


#: Words a sentence-case label may keep in capitals: names and initialisms people read as written.
CAPITALS = {"OCR", "OpenRouter", "MMR", "RRF", "BM25", "PRF", "LLM", "URL", "API", "PDF"}


def _visible_settings(schema):
    for stage, transforms in schema.items():
        if stage in ("source", "query"):
            continue
        for name, info in transforms.items():
            learn = info.get("learn") or {}
            for key, prop in (info["config_schema"].get("properties") or {}).items():
                yield f"{stage}/{name}.{key}", prop, learn.get(key)


def test_every_setting_has_a_plain_sentence_case_label(client):
    bad = []
    for where, prop, _ in _visible_settings(client.get("/api/registry").json()):
        title = prop.get("title") or ""
        words = title.split()
        ok = bool(words) and words[0][0].isupper() and all(w == w.lower() or w in CAPITALS for w in words[1:])
        # A label is words, not the code name: no underscores and not just the key title-cased.
        if not ok or "_" in title:
            bad.append(f"{where}: {title!r}")
    assert bad == []


def test_every_setting_has_one_line_of_help(client):
    missing = [where for where, prop, learn in _visible_settings(client.get("/api/registry").json()) if not (prop.get("description") or learn)]
    assert missing == []


def test_the_demo_hides_the_test_embedder_and_the_custom_endpoint_fields(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    schema = client.get("/api/registry").json()
    assert "fake-deterministic" not in schema["index"]["lancedb"]["config_schema"]["properties"]["embedder"]["enum"]
    for stage, name in (("use_case", "chat"), ("rerank", "llm_rerank")):
        props = schema[stage][name]["config_schema"]["properties"]
        assert "custom_base_url" not in props and "custom_model" not in props
    # A local run keeps them all.
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    local = client.get("/api/registry").json()
    assert "fake-deterministic" in local["index"]["lancedb"]["config_schema"]["properties"]["embedder"]["enum"]
    assert "custom_base_url" in local["use_case"]["chat"]["config_schema"]["properties"]
