"""samples/starter.yaml is the app's Starter pipeline, step for step, so it
gives the same result ids as the Starter built on Build."""

import json
from pathlib import Path

from pandion import Pipeline
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry

ROOT = Path(__file__).resolve().parents[1]

#: The Starter as the app builds it today (web/src/state/graph.ts, sampleGraph).
APP_STARTER = [
    (Stage.PARSE, "docling", {}),
    (Stage.CLEAN, "dedupe_blocks", {}),
    (Stage.CHUNK, "recursive_character", {"chunk_size": 400, "chunk_overlap": 80}),
    (Stage.INDEX, "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
    (Stage.RETRIEVE, "hybrid_rrf", {}),
    (Stage.USE_CASE, "search", {}),
]


def _validated(stage, use, settings):
    return use, registry.get(stage, use).config_model(**settings).model_dump(mode="json")


def test_the_starter_file_has_the_apps_starter_settings():
    discover()
    c = Pipeline.from_yaml(ROOT / "samples" / "starter.yaml").config
    got = [
        _validated(Stage.PARSE, *c.index.parse),
        *[_validated(Stage.CLEAN, *step) for step in c.index.clean],
        _validated(Stage.CHUNK, *c.index.chunk),
        _validated(Stage.INDEX, c.index.store_use, c.index.store),
        _validated(Stage.RETRIEVE, *c.retrieve.search),
        _validated(Stage.USE_CASE, *c.answer),
    ]
    assert got == [_validated(*step) for step in APP_STARTER]


def test_the_web_fixture_is_the_starter_file():
    data = Pipeline.from_yaml(ROOT / "samples" / "starter.yaml").to_dict()
    data.pop("path")
    data.pop("models", None)
    fixture = json.loads((ROOT / "web" / "src" / "api" / "fixtures" / "starter.config.json").read_text(encoding="utf-8"))
    assert fixture == data
