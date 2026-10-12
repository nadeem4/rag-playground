"""Moving code must never move an artifact id.

The literal ids below were computed on main before the engine moved into this
package. An artifact id is the recipe hash (`pandion.ids.compute_artifact_id`),
and every cached artifact and every saved run is found by it, so if one of
these changes, every user's cache rebuilds.
"""

import pytest

from pandion.artifacts import ArtifactType
from pandion.embedding_cache import cache_key
from pandion.embeddings import get_embedder
from pandion.ids import compute_artifact_id
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry


def test_a_parse_recipe_keeps_its_id():
    assert compute_artifact_id(
        transform_name="pdfium",
        transform_version="2",
        fingerprint="none",
        output_type=ArtifactType.PARSED_DOC,
        config={"mode": "text", "join_lines": True},
        inputs={"file": "a" * 64},
    ) == "8869fbcb4ba83d60f4b765e03459c1d515a7e504af807f1371b7c3100bdf0e8f"


def test_a_default_dedupe_blocks_node_keeps_its_id():
    """Computed on main at 85e5cbf, while the cleaner still lived in the app."""
    discover()
    cls = registry.get(Stage.CLEAN, "dedupe_blocks")
    config = cls.config_model()
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(config),
        output_type=cls.output,
        config=config.model_dump(mode="json"),
        inputs={"doc": "c" * 64},
    ) == "6e8640e11bee889ad16d73b2c0fcecadc610729e7fa4ca35866f97919ef1a2f6"


@pytest.mark.parametrize(
    "name,expected",
    [
        ("recursive_character", "e1768c47781afb61b72aafdb56311f892f529dbe8e67c17342fe36ca58553db3"),
        ("layout_blocks", "f376c71a8333c8cc1756913490e4e9721a687a34cc0c6ce2a0b57e9735d8c5cf"),
        ("markdown_header", "a6fa1c5d404d3ca267d4106d0d31c3a201950b0055d539234a8c6722197ddeb5"),
        ("token_based", "7f4d66151ef536a6ce04f0d274838d3e67a776c98e4ae7d6e5cebcd37011810c"),
        ("sentence_window", "55519eb90e6748294f5266fb949460f5c824812a23c95d281aed3b6dd426c7c6"),
    ],
)
def test_a_default_chunker_node_keeps_its_id(name, expected):
    """Computed on main at 26779a1, while the chunkers still lived in the app."""
    discover()
    cls = registry.get(Stage.CHUNK, name)
    config = cls.config_model()
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(config),
        output_type=cls.output,
        config=config.model_dump(mode="json"),
        inputs={"doc": "d" * 64},
    ) == expected


def test_a_source_recipe_keeps_its_id():
    assert compute_artifact_id(
        transform_name="upload",
        transform_version="1",
        fingerprint="none",
        output_type=ArtifactType.RAW_FILE,
        config={"sha": "b" * 64, "filename": "sample.pdf"},
        inputs={},
    ) == "8aefb26a746ed00691b742fad40d657f406db0225bb6c6b10f9fe5cb9117ab96"


@pytest.mark.parametrize(
    "config,expected",
    [
        ({}, "6754846e27131e0eb61541a429edd88e9924de58f830165f0d0d6aa627c853a3"),
        (
            {"embedder": "fake-deterministic"},
            "9f793d32fe819514a14c3d24f8ea877aa851d757264ccde677cf55e085560842",
        ),
    ],
)
def test_a_lancedb_index_node_keeps_its_id(config, expected):
    """Computed on main at 8894d6d, while the index still lived in the app."""
    discover()
    cls = registry.get(Stage.INDEX, "lancedb")
    settings = cls.config_model(**config)
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(settings),
        output_type=cls.output,
        config=settings.model_dump(mode="json"),
        inputs={"chunks": ["e" * 64, "f" * 64]},
    ) == expected


@pytest.mark.parametrize(
    "name,kind,expected",
    [
        ("fake-deterministic", "document", "dbbd1fdc6934d3b28dba00e653337ff14efc442c566a116a1e1cb55ac987c352"),
        ("fake-deterministic", "query", "d566a80e187c195890dc7f09f03ccc0ee652877e920c35a1517b2ac638e67e6f"),
        ("qwen3-embedding-0.6b", "document", "3b7e6f31ac77b9354c1fc3f8ada5519ad96a21fae90f44e656af8a673644eac0"),
        ("qwen3-embedding-0.6b", "query", "7a8e8773c1047b1c1ef8c9234d6b84f7c8f6cc959bf045c8403edbd43c322c8e"),
    ],
)
def test_an_embedding_cache_key_stays_the_same(name, kind, expected):
    """Computed on main at 8894d6d. A moved key would make every cached vector a miss."""
    p = get_embedder(name)
    assert cache_key(p.model_id, p.revision, kind, "How big should a chunk be?", p.dtype) == expected
