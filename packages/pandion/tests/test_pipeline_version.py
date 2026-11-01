"""The pipeline file may say `version`; a newer one than this Pandion reads is refused."""

import pytest

from pandion.config import ConfigError, from_dict, to_dict

BASE = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}


def test_version_1_and_no_version_are_accepted(tmp_path):
    from_dict({"version": 1, **BASE}, base=tmp_path)
    from_dict(dict(BASE), base=tmp_path)


def test_a_newer_pipeline_file_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="version 2") as caught:
        from_dict({"version": 2, **BASE}, base=tmp_path)
    assert "Upgrade pandion" in str(caught.value)


@pytest.mark.parametrize("bad", ["1", True, 0])
def test_version_must_be_a_whole_number(tmp_path, bad):
    with pytest.raises(ConfigError, match="version"):
        from_dict({"version": bad, **BASE}, base=tmp_path)


def test_to_dict_does_not_add_version(tmp_path):
    assert "version" not in to_dict(from_dict({"version": 1, **BASE}, base=tmp_path))
