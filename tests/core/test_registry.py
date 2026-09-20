"""Tests for the plugin registry and the schema the UI renders forms from."""

import json

import pytest
from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.ports import PortSpec, Stage
from core.registry import (
    DuplicateTransformError,
    Registry,
    UnknownTransformError,
    register,
)
from core.registry import registry as module_registry
from core.transform import Transform


class ChunkConfig(BaseModel):
    size: int = Field(512, description="Target chunk size in tokens")


class CleanConfig(BaseModel):
    lowercase: bool = Field(True, description="Lowercase the document text")


class FixedChunker(Transform[ChunkConfig]):
    name = "fixed"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = ChunkConfig

    def apply(self, inputs, config, ctx):
        return {"size": config.size}


class SemanticChunker(Transform[ChunkConfig]):
    """A second chunker, so name collisions can be told apart from stage ones."""

    name = "semantic"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = ChunkConfig

    def apply(self, inputs, config, ctx):
        return {"size": config.size}


class RivalFixedChunker(Transform[ChunkConfig]):
    """Same stage and same name as `FixedChunker` — must be rejected."""

    name = "fixed"
    stage = Stage.CHUNK
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = ChunkConfig

    def apply(self, inputs, config, ctx):
        return {"size": config.size}


class FixedCleaner(Transform[CleanConfig]):
    """Same name as `FixedChunker` but a different stage — must be allowed."""

    name = "fixed"
    stage = Stage.CLEAN
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.PARSED_DOC
    config_model = CleanConfig
    version = "2"
    deterministic = False
    cacheable = False
    requires = {"doc": {"format": "text"}}
    provides = {"normalized": True}

    def apply(self, inputs, config, ctx):
        return inputs["doc"]


class MergeIndexer(Transform[ChunkConfig]):
    """Exercises variadic and ambient ports in the export."""

    name = "merge"
    stage = Stage.INDEX
    inputs = {
        "chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True),
        "query": PortSpec(ArtifactType.QUERY, ambient=True, required=False),
    }
    output = ArtifactType.INDEX
    config_model = ChunkConfig

    def apply(self, inputs, config, ctx):
        return {"indexed": True}


@pytest.fixture
def reg():
    return Registry()


def test_register_returns_the_class_and_get_finds_it(reg):
    assert reg.register(FixedChunker) is FixedChunker
    assert reg.get(Stage.CHUNK, "fixed") is FixedChunker


def test_duplicate_name_in_same_stage_raises(reg):
    reg.register(FixedChunker)
    with pytest.raises(DuplicateTransformError, match="fixed"):
        reg.register(RivalFixedChunker)


def test_same_name_in_a_different_stage_is_allowed(reg):
    reg.register(FixedChunker)
    reg.register(FixedCleaner)
    assert reg.get(Stage.CHUNK, "fixed") is FixedChunker
    assert reg.get(Stage.CLEAN, "fixed") is FixedCleaner


def test_unknown_name_raises(reg):
    reg.register(FixedChunker)
    with pytest.raises(UnknownTransformError):
        reg.get(Stage.CHUNK, "nope")


def test_unknown_stage_raises(reg):
    with pytest.raises(UnknownTransformError):
        reg.get(Stage.CHUNK, "fixed")


def test_all_for_stage_is_isolated(reg):
    reg.register(FixedChunker)
    reg.register(SemanticChunker)
    reg.register(FixedCleaner)
    assert set(reg.all_for(Stage.CHUNK)) == {"fixed", "semantic"}
    assert set(reg.all_for(Stage.CLEAN)) == {"fixed"}
    assert reg.all_for(Stage.PARSE) == {}


def test_all_for_returns_a_copy(reg):
    reg.register(FixedChunker)
    reg.all_for(Stage.CHUNK).clear()
    assert reg.get(Stage.CHUNK, "fixed") is FixedChunker


def test_clear_empties_the_registry(reg):
    reg.register(FixedChunker)
    reg.clear()
    assert reg.all_for(Stage.CHUNK) == {}
    with pytest.raises(UnknownTransformError):
        reg.get(Stage.CHUNK, "fixed")


def test_export_schema_shape(reg):
    reg.register(FixedChunker)
    entry = reg.export_schema()["chunk"]["fixed"]

    assert entry["name"] == "fixed"
    assert entry["version"] == "1"
    assert entry["stage"] == "chunk"
    assert entry["output"] == "chunk_set"
    assert entry["stackable"] is False
    assert entry["deterministic"] is True
    assert entry["cacheable"] is True
    assert entry["requires"] == {}
    assert entry["provides"] == {}
    assert entry["inputs"] == {
        "doc": {
            "type": "parsed_doc",
            "variadic": False,
            "ambient": False,
            "required": True,
        }
    }


def test_export_schema_carries_class_level_overrides(reg):
    reg.register(FixedCleaner)
    entry = reg.export_schema()["clean"]["fixed"]
    assert entry["version"] == "2"
    assert entry["deterministic"] is False
    assert entry["cacheable"] is False
    assert entry["requires"] == {"doc": {"format": "text"}}
    assert entry["provides"] == {"normalized": True}


def test_export_schema_describes_variadic_and_ambient_ports(reg):
    reg.register(MergeIndexer)
    inputs = reg.export_schema()["index"]["merge"]["inputs"]
    assert inputs["chunks"] == {
        "type": "chunk_set",
        "variadic": True,
        "ambient": False,
        "required": True,
    }
    assert inputs["query"] == {
        "type": "query",
        "variadic": False,
        "ambient": True,
        "required": False,
    }


def test_export_schema_preserves_config_defaults_and_descriptions(reg):
    reg.register(FixedChunker)
    props = reg.export_schema()["chunk"]["fixed"]["config_schema"]["properties"]
    assert props["size"]["default"] == 512
    assert props["size"]["description"] == "Target chunk size in tokens"


class TitleEnricher(Transform[ChunkConfig]):
    name = "titles"
    stage = Stage.ENRICH
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET)}
    output = ArtifactType.CHUNK_SET
    config_model = ChunkConfig

    def apply(self, inputs, config, ctx):
        return inputs["chunks"]


class RewriteQuery(Transform[ChunkConfig]):
    name = "rewrite"
    stage = Stage.QUERY_TRANSFORM
    inputs = {"query": PortSpec(ArtifactType.QUERY)}
    output = ArtifactType.QUERY
    config_model = ChunkConfig

    def apply(self, inputs, config, ctx):
        return inputs["query"]


class CrossEncoderRerank(Transform[ChunkConfig]):
    name = "cross_encoder"
    stage = Stage.RERANK
    inputs = {"hits": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
    output = ArtifactType.RETRIEVAL_RESULT
    config_model = ChunkConfig

    def apply(self, inputs, config, ctx):
        return inputs["hits"]


@pytest.mark.parametrize(
    "transform_cls, stage_key",
    [
        (FixedCleaner, "clean"),
        (TitleEnricher, "enrich"),
        (RewriteQuery, "query_transform"),
        (CrossEncoderRerank, "rerank"),
    ],
)
def test_stackable_stages_are_marked_stackable(reg, transform_cls, stage_key):
    reg.register(transform_cls)
    entry = reg.export_schema()[stage_key][transform_cls.name]
    assert entry["stage"] == stage_key
    assert entry["stackable"] is True


def test_non_stackable_stage_is_not_marked_stackable(reg):
    reg.register(MergeIndexer)
    assert reg.export_schema()["index"]["merge"]["stackable"] is False


def test_export_schema_is_empty_for_an_empty_registry(reg):
    assert reg.export_schema() == {}


def test_export_schema_is_json_serializable(reg):
    reg.register(FixedChunker)
    reg.register(FixedCleaner)
    reg.register(MergeIndexer)
    round_tripped = json.loads(json.dumps(reg.export_schema()))
    assert round_tripped["chunk"]["fixed"]["output"] == "chunk_set"
    assert round_tripped["clean"]["fixed"]["stackable"] is True


def test_register_decorator_writes_to_the_module_registry():
    @register
    class DecoratorProbe(Transform[ChunkConfig]):
        name = "decorator_probe"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = ChunkConfig

        def apply(self, inputs, config, ctx):
            return {}

    assert DecoratorProbe.name == "decorator_probe"
    assert module_registry.get(Stage.CHUNK, "decorator_probe") is DecoratorProbe
