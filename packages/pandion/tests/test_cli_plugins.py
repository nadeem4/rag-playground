"""`pandion plugins` lists every extension point that is loaded."""

import json
import sys
import textwrap

import pytest

from pandion import cli
from pandion.extend import Stage
from pandion.registry import registry

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
    monkeypatch.chdir(tmp_path)
    yield "my_plugin_mod"
    sys.modules.pop("my_plugin_mod", None)
    registry._by_stage[Stage.PARSE].pop("loaded_from_plugins", None)


def test_plugins_lists_a_builtin_with_its_module_and_level(capsys):
    assert cli.main(["plugins"]) == 0
    lines = capsys.readouterr().out.splitlines()
    line = next(x for x in lines if x.startswith("route check") and "file_type" in x)
    assert "pandion.plugins.route.checks" in line
    assert "stable" in line


def test_plugins_lists_a_plugin_loaded_with_the_flag(capsys, plugin_module):
    assert cli.main(["plugins", "--plugins", plugin_module]) == 0
    line = next(x for x in capsys.readouterr().out.splitlines() if "parse/loaded_from_plugins" in x)
    assert "my_plugin_mod" in line
    assert "provisional" in line


def test_plugins_json_is_a_list_of_objects_with_the_four_keys(capsys):
    assert cli.main(["plugins", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows
    assert all(set(r) == {"kind", "name", "module", "level"} for r in rows)


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


def test_a_broken_entry_point_stops_the_cli_without_the_flag(monkeypatch):
    _break_entry_point(monkeypatch)
    with pytest.warns(UserWarning):
        with pytest.raises(cli.ConfigError) as caught:
            cli.load_plugins(None)
    assert "broken_ep" in str(caught.value)
    assert "installed plugin" in str(caught.value)
    assert "--plugins names" not in str(caught.value)


def test_a_listed_module_that_cannot_import_keeps_its_message(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(cli.ConfigError, match="--plugins names 'no_such_mod', which cannot be imported"):
        cli.load_plugins("no_such_mod")
