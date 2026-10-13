"""Any registered index strategy can be the store."""

import json
from pathlib import Path

import pytest
from pydantic import BaseModel

from pandion import Pipeline
from pandion.config import ConfigError, from_dict, to_dict
from pandion.extend import ArtifactType, ChunkSet, PortSpec, Stage, Transform, register
from pandion.registry import registry
from pdfs import SAMPLE_PAGES, build_pdf


class JsonlSettings(BaseModel):
    embedder: str = "fake-deterministic"


class JsonlStore(Transform[JsonlSettings]):
    name = "test_jsonl_store"
    stage = Stage.INDEX
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)}
    output = ArtifactType.INDEX
    config_model = JsonlSettings
    provides = {"backends": ["dense"]}
    summary = "Pieces in a JSON Lines file."

    def apply(self, inputs, config, ctx):
        pieces = [c for cs in inputs["chunks"] for c in ChunkSet.model_validate(cs).chunks]

        def write(folder: Path) -> None:
            with open(folder / "pieces.jsonl", "w", encoding="utf-8") as f:
                for c in pieces:
                    f.write(json.dumps({"id": c.id, "text": c.text}) + "\n")

        return write


class SelfSettings(BaseModel):
    pass


class SelfEmbeddingStore(JsonlStore):
    name = "test_self_embedding_store"
    config_model = SelfSettings
    summary = "A store that embeds by itself."


@pytest.fixture(autouse=True, scope="module")
def _stores():
    """Register the test stores for this file only, so no other test sees them."""
    from pandion.plugins import discover

    discover()
    register(JsonlStore)
    register(SelfEmbeddingStore)
    yield
    for name in (JsonlStore.name, SelfEmbeddingStore.name):
        registry._by_stage[Stage.INDEX].pop(name, None)


def _config(store, embed=True):
    index = {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"}, "store": store}
    if embed:
        index["embed"] = {"use": "fake-deterministic"}
    return {"path": "./index", "index": index}


def test_a_custom_store_is_accepted_and_gets_the_embedder(tmp_path):
    c = from_dict(_config({"use": "test_jsonl_store"}), base=tmp_path)
    assert c.index.store_use == "test_jsonl_store"
    assert c.index.store["embedder"] == "fake-deterministic"


def test_a_store_without_an_embedder_setting_refuses_embed(tmp_path):
    with pytest.raises(ConfigError, match="embeds by itself"):
        from_dict(_config({"use": "test_self_embedding_store"}), base=tmp_path)
    assert from_dict(_config({"use": "test_self_embedding_store"}, embed=False), base=tmp_path)


def test_lancedb_still_needs_embed(tmp_path):
    with pytest.raises(ConfigError, match="embed"):
        from_dict(_config({"use": "lancedb"}, embed=False), base=tmp_path)


def test_to_dict_round_trips_a_custom_store(tmp_path):
    c = from_dict(_config({"use": "test_jsonl_store"}), base=tmp_path)
    assert from_dict(to_dict(c), base=tmp_path) == c


def test_to_dict_leaves_embed_out_for_a_store_that_embeds_by_itself(tmp_path):
    c = from_dict(_config({"use": "test_self_embedding_store"}, embed=False), base=tmp_path)
    data = to_dict(c)
    assert "embed" not in data["index"]
    assert data["index"]["store"] == {"use": "test_self_embedding_store"}
    assert from_dict(data, base=tmp_path) == c


def test_an_unknown_store_lists_the_stores(tmp_path):
    with pytest.raises(ConfigError, match="'qdrant', which is not a store.*lancedb"):
        from_dict(_config({"use": "qdrant"}), base=tmp_path)


def test_the_embedder_cannot_be_set_on_the_store(tmp_path):
    with pytest.raises(ConfigError, match="index.store sets 'embedder'.*index.embed"):
        from_dict(_config({"use": "lancedb", "embedder": "fake-deterministic"}), base=tmp_path)


def test_a_custom_store_runs_in_a_pipeline(tmp_path):
    f = tmp_path / "r.pdf"
    f.write_bytes(build_pdf(SAMPLE_PAGES))
    report = Pipeline._of(from_dict(_config({"use": "test_jsonl_store"}), base=tmp_path)).index.run(f)
    assert report.ok and report.index.transform == "test_jsonl_store"
