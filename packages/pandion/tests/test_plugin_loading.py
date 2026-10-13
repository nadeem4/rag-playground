"""Strategies load from a plugins: list in the file, or from installed packages."""

import sys
import textwrap
import warnings

import pytest

from pandion.extend import Stage

from pandion.config import ConfigError, from_dict, to_dict

BASE = {
    "path": "./index",
    "index": {
        "parse": {"use": "loaded_from_plugins"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}

MODULE = textwrap.dedent('''
    from pydantic import BaseModel
    from pandion.extend import ArtifactType, ParsedDoc, PortSpec, Stage, Transform, register

    class S(BaseModel):
        pass

    @register
    class P(Transform[S]):
        name = "loaded_from_plugins"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = S
        summary = "A parser loaded by name."

        def apply(self, inputs, config, ctx):
            return ParsedDoc(elements=[])
''')


@pytest.fixture
def plugin_module(tmp_path, monkeypatch):
    (tmp_path / "my_plugin_mod.py").write_text(MODULE, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    yield "my_plugin_mod"
    sys.modules.pop("my_plugin_mod", None)
    from pandion.registry import registry

    registry._by_stage[Stage.PARSE].pop("loaded_from_plugins", None)


def test_without_plugins_the_name_is_unknown(tmp_path):
    with pytest.raises(ConfigError, match="not a parse strategy"):
        from_dict({**BASE, "index": {**BASE["index"], "parse": {"use": "never_registered_xyz"}}}, base=tmp_path)


def test_plugins_are_imported_before_the_steps_are_checked(tmp_path, plugin_module):
    config = from_dict({"plugins": [plugin_module], **BASE}, base=tmp_path)
    assert config.plugins == [plugin_module]
    assert config.index.parse[0] == "loaded_from_plugins"
    assert to_dict(config)["plugins"] == [plugin_module]


def test_a_plugin_that_fails_to_import_names_the_module_and_the_error(tmp_path, monkeypatch):
    (tmp_path / "broken_mod.py").write_text("import not_a_real_dependency_xyz\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(ConfigError, match=r"broken_mod.*not_a_real_dependency_xyz"):
        from_dict({"plugins": ["broken_mod"], **BASE}, base=tmp_path)


def test_a_plugin_that_clashes_with_a_built_in_is_blamed(tmp_path, monkeypatch):
    clash = MODULE.replace("loaded_from_plugins", "pdfium")
    (tmp_path / "clash_mod.py").write_text(clash, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        with pytest.raises(ConfigError, match=r"clash_mod.*already registered"):
            from_dict({"plugins": ["clash_mod"], **BASE}, base=tmp_path)
    finally:
        sys.modules.pop("clash_mod", None)


def test_plugins_must_be_a_list_of_module_names(tmp_path):
    with pytest.raises(ConfigError, match="plugins must be a list"):
        from_dict({"plugins": "my_mod", **BASE}, base=tmp_path)


def test_entry_points_load_in_discover_and_a_broken_one_only_warns(monkeypatch):
    import pandion.plugins as plugins

    class EP:
        def __init__(self, name, value):
            self.name, self.value = name, value

        def load(self):
            if self.value == "boom":
                raise ImportError("boom")
            return __import__(self.value)

    loaded = []
    monkeypatch.setattr(plugins, "_entry_points", lambda: [EP("good", "json"), EP("bad", "boom")])
    monkeypatch.setattr(plugins, "_discovered", False)
    monkeypatch.setattr(plugins, "_load_entry_point", lambda ep: loaded.append(ep.name) or ep.load())
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        plugins.discover()
    assert "good" in loaded
    assert any("bad" in str(w.message) and "boom" in str(w.message) for w in caught)
