"""One loader for plugin modules: built-ins, entry points, then the listed modules."""

import sys
import textwrap

import pytest

import pandion.plugins as plugins
from pandion.extend import Stage
from pandion.plugins import PluginError, load
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

DUPLICATE = textwrap.dedent('''
    from pydantic import BaseModel
    from pandion.extend import ArtifactType, PortSpec, Stage, Transform, register

    class S(BaseModel):
        pass

    @register
    class Again(Transform[S]):
        name = "upload"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = S
        summary = "A second upload."

        def apply(self, inputs, config, ctx):
            return None
''')


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setattr(plugins, "_failed", [])
    yield
    for name in ("my_plugin_mod", "bad_mod", "dup_mod", "order_mod"):
        sys.modules.pop(name, None)
    registry._by_stage.get(Stage.PARSE, {}).pop("loaded_from_plugins", None)


def write(tmp_path, name, text):
    (tmp_path / f"{name}.py").write_text(text, encoding="utf-8")


def test_load_imports_a_module_from_the_project_folder(tmp_path):
    write(tmp_path, "my_plugin_mod", MODULE)
    assert load(tmp_path, ["my_plugin_mod"]) == ["my_plugin_mod"]
    assert "loaded_from_plugins" in registry.all_for(Stage.PARSE)


def test_the_project_folder_is_on_sys_path_only_while_importing(tmp_path):
    write(tmp_path, "my_plugin_mod", MODULE)
    load(tmp_path, ["my_plugin_mod"])
    assert str(tmp_path.resolve()) not in sys.path


def test_a_module_that_fails_to_import_stops_the_load(tmp_path):
    write(tmp_path, "bad_mod", 'raise RuntimeError("boom")\n')
    with pytest.raises(PluginError) as caught:
        load(tmp_path, ["bad_mod"])
    assert caught.value.module == "bad_mod"
    assert isinstance(caught.value.cause, RuntimeError)


def test_a_missing_module_stops_the_load(tmp_path):
    with pytest.raises(PluginError) as caught:
        load(tmp_path, ["no_such_mod"])
    assert caught.value.module == "no_such_mod"


def test_a_broken_entry_point_stops_the_load(tmp_path, monkeypatch):
    class EP:
        name, value = "broken_ep", "broken_ep_pkg"

    def fail(ep):
        raise ImportError("no good")

    monkeypatch.setattr(plugins, "_discovered", False)
    monkeypatch.setattr(plugins, "_entry_points", lambda: [EP()])
    monkeypatch.setattr(plugins, "_load_entry_point", fail)
    with pytest.warns(UserWarning):
        with pytest.raises(PluginError) as caught:
            load(tmp_path, [])
    assert caught.value.module == "broken_ep"


def test_a_name_registered_twice_names_both_modules(tmp_path):
    write(tmp_path, "dup_mod", DUPLICATE)
    with pytest.raises(PluginError) as caught:
        load(tmp_path, ["dup_mod"])
    assert "pandion.plugins.source.upload" in str(caught.value.cause)
    assert "dup_mod" in str(caught.value.cause)


def test_entry_points_load_before_the_listed_modules(tmp_path, monkeypatch):
    import builtins

    order: list[str] = []
    monkeypatch.setattr(builtins, "_order", order, raising=False)
    write(tmp_path, "order_mod", "import builtins\nbuiltins._order.append('module')\n")

    class EP:
        name, value = "ep", "ep"

    monkeypatch.setattr(plugins, "_discovered", False)
    monkeypatch.setattr(plugins, "_entry_points", lambda: [EP()])
    monkeypatch.setattr(plugins, "_load_entry_point", lambda ep: order.append("entry"))
    load(tmp_path, ["order_mod"])
    assert order == ["entry", "module"]
