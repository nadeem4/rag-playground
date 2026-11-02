"""The extension examples in examples/pandion/extensions run, so their README recipes cannot go stale.

Each module registers a name once, so it is imported once per test process.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

from pandion import Pipeline
from pandion.access import AccessConfig, resolve_roles
from pandion.docinfo import DocumentInfo
from pandion.document_sources import get_source
from pandion.testing import store_conformance

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples" / "pandion" / "extensions"
PDF = ROOT / "samples" / "chunking-primer" / "chunking-primer.pdf"
_LOADED: dict[str, object] = {}


def load(name: str):
    if name not in _LOADED:
        spec = importlib.util.spec_from_file_location(f"extension_example_{name}", EXAMPLES / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _LOADED[name] = module
    return _LOADED[name]


def make_zip(path: Path, entries: dict[str, bytes]) -> str:
    with zipfile.ZipFile(path, "w") as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return str(path)


def test_zip_source_lists_versions_and_reads_bytes(tmp_path):
    source = load("zip_source").ZipSource(make_zip(tmp_path / "d.zip", {"b.txt": b"bee", "a/c.txt": b"sea"}))
    entries = list(source.list())
    assert [e.doc_id for e in entries] == ["a/c.txt", "b.txt"]
    assert all(e.version and e.metadata == {"path": e.doc_id} for e in entries)
    assert source.read("b.txt") == b"bee"


def test_zip_source_version_changes_when_an_entry_changes(tmp_path):
    zip_source = load("zip_source")
    before = {e.doc_id: e.version for e in zip_source.ZipSource(make_zip(tmp_path / "1.zip", {"a": b"one", "b": b"two"})).list()}
    after = {e.doc_id: e.version for e in zip_source.ZipSource(make_zip(tmp_path / "2.zip", {"a": b"one", "b": b"three"})).list()}
    assert after["a"] == before["a"] and after["b"] != before["b"]


def test_zip_source_is_registered_by_name(tmp_path):
    zip_source = load("zip_source")
    source = get_source("zip", path=make_zip(tmp_path / "d.zip", {"a": b"x"}))
    assert isinstance(source, zip_source.ZipSource)


def test_zip_source_syncs_into_an_index(tmp_path):
    load("zip_source")
    config = yaml.safe_load((ROOT / "examples" / "pandion" / "cli.yaml").read_text(encoding="utf-8"))
    config["path"] = str(tmp_path / "index")
    file = tmp_path / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config), encoding="utf-8")
    source = get_source("zip", path=make_zip(tmp_path / "d.zip", {"primer.pdf": PDF.read_bytes()}))

    report = Pipeline.from_file(file).index.sync(source)

    assert report.added == ["primer.pdf"] and report.complete


def test_a_source_that_lists_nothing_is_refused(tmp_path):
    load("zip_source")
    config = yaml.safe_load((ROOT / "examples" / "pandion" / "cli.yaml").read_text(encoding="utf-8"))
    config["path"] = str(tmp_path / "index")
    file = tmp_path / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config), encoding="utf-8")
    source = get_source("zip", path=make_zip(tmp_path / "empty.zip", {}))

    with pytest.raises(ValueError):
        Pipeline.from_file(file).index.sync(source)


def _info(path: str) -> DocumentInfo:
    return DocumentInfo(
        filename="a.txt", type="txt", size=1, path=path, metadata={}, properties={},
        page_count=None, text_layer=None, first_page_text="",
    )


def test_owner_access_gives_the_team_folder_its_role():
    load("owner_access")
    got = resolve_roles("legal/a.txt", _info("legal/a.txt"), AccessConfig(rules=["team_from_path"]))
    assert got.roles == ["legal"]


def test_owner_access_has_no_opinion_outside_a_team_folder():
    load("owner_access")
    got = resolve_roles("a.txt", _info("a.txt"), AccessConfig(default=["staff"], rules=["team_from_path"]))
    assert got.roles == ["staff"] and got.reason == "default"


def test_json_file_store_passes_the_store_conformance_suite(tmp_path):
    store_cls = load("json_file_store").JsonFileStore
    made = []

    def factory():
        made.append(tmp_path / f"store{len(made)}")
        return store_cls(store_cls.settings_model(folder=str(made[-1])))

    store_conformance(factory)


def test_the_example_modules_import_no_heavy_library():
    code = (
        "import sys, importlib.util\n"
        "for n in ('zip_source', 'owner_access', 'json_file_store'):\n"
        f"    s = importlib.util.spec_from_file_location(n, r'{EXAMPLES}/' + n + '.py')\n"
        "    importlib.util.module_from_spec(s); s.loader.exec_module(importlib.util.module_from_spec(s))\n"
        "heavy = {'numpy', 'torch', 'lancedb', 'fsspec', 'pyarrow', 'pandas'}\n"
        "assert not heavy & set(sys.modules), heavy & set(sys.modules)\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
