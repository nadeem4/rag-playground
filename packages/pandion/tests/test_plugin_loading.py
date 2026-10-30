"""Strategies load from a plugins: list in the file, or from installed packages."""

import subprocess
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
    assert config.index.default.parse[0] == "loaded_from_plugins"
    assert to_dict(config)["plugins"] == [plugin_module]


def test_a_plugin_that_fails_to_import_names_the_module_and_the_error(tmp_path, monkeypatch):
    (tmp_path / "broken_mod.py").write_text("import not_a_real_dependency_xyz\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(ConfigError, match=r"broken_mod.*not_a_real_dependency_xyz"):
        from_dict({"plugins": ["broken_mod"], **BASE}, base=tmp_path)


CLASH_CODE = textwrap.dedent("""
    import sys
    sys.path.insert(0, ".")
    from pandion.config import from_dict, ConfigError

    data = {
        "plugins": ["clash_mod"],
        "path": "./index",
        "index": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character"},
            "embed": {"use": "fake-deterministic"},
            "store": {"use": "lancedb"},
        },
    }
    try:
        from_dict(data, base=__import__("pathlib").Path("."))
    except ConfigError as exc:
        print("CONFIGERROR:", exc)
    else:
        print("NO ERROR")
""")


def test_a_plugin_that_clashes_with_a_built_in_is_blamed(tmp_path):
    # A fresh interpreter, so discover() has not run before the plugin loads.
    (tmp_path / "clash_mod.py").write_text(MODULE.replace("loaded_from_plugins", "pdfium"), encoding="utf-8")
    run = subprocess.run(
        [sys.executable, "-c", CLASH_CODE], cwd=tmp_path, capture_output=True, text=True, timeout=120
    )
    assert run.returncode == 0, run.stderr
    assert "CONFIGERROR:" in run.stdout
    assert "clash_mod" in run.stdout
    assert "already registered" in run.stdout


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


BESIDE = MODULE.replace("loaded_from_plugins", "beside_the_file")

PIPELINE_BESIDE = textwrap.dedent("""
    plugins: [mymod_beside_file]
    path: ./index
    index:
      parse: {use: beside_the_file}
      chunk: {use: recursive_character}
      embed: {use: fake-deterministic}
      store: {use: lancedb}
    retrieve:
      search: {use: dense}
""")


@pytest.fixture
def beside_the_file(tmp_path):
    """A pipeline file with its plugin module in the same folder."""
    folder = tmp_path / "project"
    folder.mkdir()
    (folder / "mymod_beside_file.py").write_text(BESIDE, encoding="utf-8")
    (folder / "pipeline.yaml").write_text(PIPELINE_BESIDE, encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    yield folder, elsewhere
    sys.modules.pop("mymod_beside_file", None)
    from pandion.registry import registry

    registry._by_stage[Stage.PARSE].pop("beside_the_file", None)


def test_load_imports_a_plugin_from_the_files_folder(beside_the_file, monkeypatch):
    from pandion.config import load

    folder, elsewhere = beside_the_file
    monkeypatch.chdir(elsewhere)
    path_before = list(sys.path)
    config = load(folder / "pipeline.yaml")
    assert config.index.default.parse[0] == "beside_the_file"
    assert sys.path == path_before
    assert "mymod_beside_file" in sys.modules


def test_from_dict_imports_a_plugin_from_base(beside_the_file, monkeypatch):
    import yaml

    folder, elsewhere = beside_the_file
    monkeypatch.chdir(elsewhere)
    data = yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))
    path_before = list(sys.path)
    assert from_dict(data, base=folder).index.default.parse[0] == "beside_the_file"
    assert sys.path == path_before


def test_the_cli_finds_a_plugin_beside_the_file(beside_the_file):
    folder, elsewhere = beside_the_file
    run = subprocess.run(
        [sys.executable, "-m", "pandion.cli", "install", "--print", str(folder / "pipeline.yaml")],
        cwd=elsewhere, capture_output=True, text=True, timeout=120,
    )
    assert run.returncode == 0, run.stderr
    assert "pip install" in run.stdout


def test_the_retrieval_and_query_parts_keep_the_plugins(beside_the_file):
    from pandion import Pipeline, QueryPipeline, RetrievalPipeline

    folder, _ = beside_the_file
    p = Pipeline.from_yaml(folder / "pipeline.yaml")
    retrieval = RetrievalPipeline(p.index, search="dense")
    assert retrieval.config.plugins == ["mymod_beside_file"]
    assert to_dict(retrieval.config)["plugins"] == ["mymod_beside_file"]
    query = QueryPipeline(retrieval, answer="search")
    assert query.config.plugins == ["mymod_beside_file"]
    assert to_dict(query.config)["plugins"] == ["mymod_beside_file"]
