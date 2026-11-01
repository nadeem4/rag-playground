import json

import pytest

from pandion.errors import FormatTooNew
from pandion.manifest import Manifest


def test_a_manifest_without_a_version_reads_as_version_1(tmp_path):
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps({"index_recipe": "x", "documents": {}}), encoding="utf-8")
    assert Manifest.load(p).format_version == 1


def test_save_writes_the_format_version(tmp_path):
    p = tmp_path / "manifest.json"
    Manifest().save(p)
    assert json.loads(p.read_text())["format_version"] == 1


def test_a_newer_manifest_is_refused(tmp_path):
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps({"format_version": 2}), encoding="utf-8")
    with pytest.raises(FormatTooNew, match="Upgrade pandion") as info:
        Manifest.load(p)
    message = str(info.value)
    assert str(p) in message and "2" in message and "1" in message


def test_unknown_manifest_keys_are_ignored(tmp_path):
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps({"format_version": 1, "future_field": 3}), encoding="utf-8")
    assert Manifest.load(p).format_version == 1


def test_a_format_version_that_is_not_a_number_is_a_plain_error(tmp_path):
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps({"format_version": "two"}), encoding="utf-8")
    with pytest.raises(ValueError, match="format_version"):
        Manifest.load(p)
