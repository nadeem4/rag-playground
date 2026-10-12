"""Moving code must never move an artifact id.

The literal ids below were computed on main before the engine moved into this
package. An artifact id is the recipe hash (`pandion.ids.compute_artifact_id`),
and every cached artifact and every saved run is found by it, so if one of
these changes, every user's cache rebuilds.
"""

import pytest

from pandion.artifacts import ArtifactType
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
