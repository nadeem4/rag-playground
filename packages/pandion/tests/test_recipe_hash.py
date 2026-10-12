"""Moving code must never move an artifact id.

The literal ids below were computed on main before the engine moved into this
package. An artifact id is the recipe hash (`pandion.ids.compute_artifact_id`),
and every cached artifact and every saved run is found by it, so if one of
these changes, every user's cache rebuilds.
"""

from pandion.artifacts import ArtifactType
from pandion.ids import compute_artifact_id


def test_a_parse_recipe_keeps_its_id():
    assert compute_artifact_id(
        transform_name="pdfium",
        transform_version="2",
        fingerprint="none",
        output_type=ArtifactType.PARSED_DOC,
        config={"mode": "text", "join_lines": True},
        inputs={"file": "a" * 64},
    ) == "8869fbcb4ba83d60f4b765e03459c1d515a7e504af807f1371b7c3100bdf0e8f"


def test_a_source_recipe_keeps_its_id():
    assert compute_artifact_id(
        transform_name="upload",
        transform_version="1",
        fingerprint="none",
        output_type=ArtifactType.RAW_FILE,
        config={"sha": "b" * 64, "filename": "sample.pdf"},
        inputs={},
    ) == "8aefb26a746ed00691b742fad40d657f406db0225bb6c6b10f9fe5cb9117ab96"
