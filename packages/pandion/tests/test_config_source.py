"""The top-level `source:` block of the pipeline file."""

from __future__ import annotations

from pathlib import Path

import pytest

from pandion import manifest
from pandion.config import ConfigError, from_dict, to_dict

BASE = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}


def load(**extra):
    return from_dict({**BASE, **extra}, base=Path("."))


def test_source_block_is_read_into_the_config():
    config = load(source={"use": "files", "location": "gs://bucket/docs"})
    assert config.source == ("files", {"location": "gs://bucket/docs"})


def test_source_block_round_trips_through_to_dict():
    block = {"use": "files", "location": "gs://bucket/docs"}
    data = to_dict(load(source=block))
    assert data["source"] == block
    assert "version" not in data
    assert list(data).index("path") < list(data).index("source") < list(data).index("index")


def test_no_source_block_means_none_and_no_key():
    config = load()
    assert config.source is None
    assert "source" not in to_dict(config)


def test_source_needs_use():
    with pytest.raises(ConfigError, match="source"):
        load(source={"location": "./docs"})


def test_source_is_not_a_mapping():
    with pytest.raises(ConfigError, match="source"):
        load(source="files")


def test_unknown_source_names_the_choices():
    with pytest.raises(ConfigError, match="files") as exc:
        load(source={"use": "nope"})
    assert "nope" in str(exc.value)


def test_source_with_an_unknown_setting_is_refused():
    with pytest.raises(ConfigError, match="locaton"):
        load(source={"use": "files", "locaton": "x"})


def test_source_block_does_not_change_the_recipe_hash():
    without = load()
    with_block = load(source={"use": "files", "location": "./docs"})
    assert manifest.recipe_hash(without.index) == manifest.recipe_hash(with_block.index)


def test_index_source_still_works_beside_a_source_block():
    config = load(
        source={"use": "files", "location": "./docs"},
        index={**BASE["index"], "source": {"use": "upload"}},
    )
    assert config.index.source == ("upload", {})
    assert config.source is not None


def test_source_block_with_an_access_block_is_allowed():
    config = load(source={"use": "files", "location": "./docs"}, access={"default": ["staff"]})
    assert config.access is not None


def test_a_relative_location_is_read_from_the_files_folder(tmp_path):
    config = from_dict({**BASE, "source": {"use": "files", "location": "./docs"}}, base=tmp_path)
    assert config.source == ("files", {"location": str(tmp_path / "docs")})


def test_an_address_and_an_absolute_location_are_kept(tmp_path):
    absolute = str((tmp_path / "abs").resolve())
    for location in ("gs://bucket/docs", absolute):
        config = from_dict({**BASE, "source": {"use": "files", "location": location}}, base=tmp_path)
        assert config.source == ("files", {"location": location})


def test_source_errors_do_not_name_the_index_source_step():
    with pytest.raises(ConfigError) as exc:
        load(source="files")
    assert exc.value.step is None
