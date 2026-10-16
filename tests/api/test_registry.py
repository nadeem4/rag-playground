"""GET /api/stages, and the catalog as the playground serves it on
GET /api/v2/strategies, through `PlaygroundPolicy.strategies` and
`playground.backend.routes.registry.served_catalog`."""

from __future__ import annotations

from playground.backend.stage_copy import STAGE_LESSON, STAGE_WHAT
from pandion.extend import Stage
from pandion.plugins import PLUGIN_MODULES


def test_the_catalog_lists_every_plugin_with_its_contract(client):
    r = client.get("/api/v2/strategies")
    assert r.status_code == 200
    body = r.json()["stages"]
    entries = [t for stage in body.values() for t in stage.values()]
    assert len(entries) == len(PLUGIN_MODULES) == 24
    for t in entries:
        for key in ("config_schema", "inputs", "output", "stackable", "learn"):
            assert key in t, (t["name"], key)
    assert body["clean"]["dedupe_blocks"]["stackable"] is True
    assert body["chunk"]["recursive_character"]["stackable"] is False


def test_the_catalog_exports_each_plugins_learn_data(client):
    body = client.get("/api/v2/strategies").json()["stages"]
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
    for where, prop, _ in _visible_settings(client.get("/api/v2/strategies").json()["stages"]):
        title = prop.get("title") or ""
        words = title.split()
        ok = bool(words) and words[0][0].isupper() and all(w == w.lower() or w in CAPITALS for w in words[1:])
        # A label is words, not the code name: no underscores and not just the key title-cased.
        if not ok or "_" in title:
            bad.append(f"{where}: {title!r}")
    assert bad == []


def test_every_setting_has_one_line_of_help(client):
    missing = [where for where, prop, learn in _visible_settings(client.get("/api/v2/strategies").json()["stages"]) if not (prop.get("description") or learn)]
    assert missing == []


def test_the_demo_hides_the_test_embedder_and_the_custom_endpoint_fields(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    schema = client.get("/api/v2/strategies").json()["stages"]
    assert "fake-deterministic" not in schema["index"]["lancedb"]["config_schema"]["properties"]["embedder"]["enum"]
    for stage, name in (("use_case", "chat"), ("rerank", "llm_rerank")):
        props = schema[stage][name]["config_schema"]["properties"]
        assert "custom_base_url" not in props and "custom_model" not in props
    # A local run keeps them all.
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    local = client.get("/api/v2/strategies").json()["stages"]
    assert "fake-deterministic" in local["index"]["lancedb"]["config_schema"]["properties"]["embedder"]["enum"]
    assert "custom_base_url" in local["use_case"]["chat"]["config_schema"]["properties"]


def test_choices_named_in_code_get_plain_names(client):
    # A select shows `x-labels` when it has them; these choices are code otherwise.
    schema = client.get("/api/v2/strategies").json()["stages"]
    for stage, name, key in (("index", "lancedb", "embedder"), ("index", "lancedb", "metric"), ("use_case", "chat", "citation_method")):
        prop = schema[stage][name]["config_schema"]["properties"][key]
        assert set(prop.get("x-labels", {})) == set(prop["enum"]), f"{name}.{key}"
    labels = schema["index"]["lancedb"]["config_schema"]["properties"]["metric"]["x-labels"]
    assert labels == {"cosine": "Cosine: the angle between vectors", "l2": "L2: the straight-line distance"}


def test_the_prompts_stay_out_of_the_forms_until_they_can_be_shown_read_only(client):
    import pandion

    body = client.get("/api/v2/strategies").json()["stages"]
    for stage, name, key in (
        ("use_case", "chat", "prompt"),
        ("use_case", "chat", "sentence_prompt"),
        ("rerank", "llm_rerank", "prompt"),
        ("query", "llm_rewrite", "prompt"),
    ):
        assert key not in body[stage][name]["config_schema"]["properties"], f"{name}.{key}"
        assert pandion.catalog()[stage][name]["config_schema"]["properties"][key]["readOnly"] is True
    assert "max_tokens" in body["use_case"]["chat"]["config_schema"]["properties"]


def test_the_cross_encoder_revision_stays_out_of_the_forms(client):
    import pandion

    body = client.get("/api/v2/strategies").json()["stages"]
    assert "revision" not in body["rerank"]["cross_encoder"]["config_schema"]["properties"]
    assert pandion.catalog()["rerank"]["cross_encoder"]["config_schema"]["properties"]["revision"]["readOnly"] is True


def test_stages_lists_every_stage_with_what_it_is_for(client):
    r = client.get("/api/stages")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {str(s) for s in Stage}
    for stage in Stage:
        expected = {"what": STAGE_WHAT[stage]}
        if stage in STAGE_LESSON:
            expected["lesson"] = STAGE_LESSON[stage]
        assert body[str(stage)] == expected


def test_the_enrich_stage_says_what_it_does_now_that_it_has_a_strategy(client):
    what = client.get("/api/stages").json()["enrich"]["what"]
    assert "available yet" not in what
    assert "model" in what
    # A custom endpoint may need none.
    assert "usually needs an API key" in what


def test_stages_carries_the_chunk_lesson_and_only_where_one_exists(client):
    body = client.get("/api/stages").json()
    lesson = body["chunk"]["lesson"]
    assert len(lesson) == 2
    assert lesson[0].startswith("Before a search can find anything")
    assert "lesson" not in body["parse"]
