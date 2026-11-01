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


def _break_entry_point(monkeypatch):
    import pandion.plugins as plugins

    class EP:
        name, value = "broken_ep", "broken_ep_pkg"

    def fail(ep):
        raise ImportError("no good")

    monkeypatch.setattr(plugins, "_failed", [])
    monkeypatch.setattr(plugins, "_discovered", False)
    monkeypatch.setattr(plugins, "_entry_points", lambda: [EP()])
    monkeypatch.setattr(plugins, "_load_entry_point", fail)


def test_a_broken_entry_point_stops_a_file_with_no_plugins_list(tmp_path, monkeypatch):
    _break_entry_point(monkeypatch)
    with pytest.warns(UserWarning):
        with pytest.raises(ConfigError) as caught:
            from_dict(dict(BASE), base=tmp_path)
    assert "broken_ep" in str(caught.value)
    assert "installed plugin" in str(caught.value)
    assert "plugins lists" not in str(caught.value)
