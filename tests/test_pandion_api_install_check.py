"""The tag check and version source of the pandion-api install check."""

from __future__ import annotations

import importlib.util
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_check():
    spec = importlib.util.spec_from_file_location(
        "api_run_check", ROOT / "checks" / "pandion-api-install" / "run_check.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tag_must_name_the_package_version():
    module = run_check()
    assert module.tag_matches("pandion-api-v0.1.0", "0.1.0")
    assert not module.tag_matches("pandion-api-v0.1.1", "0.1.0")
    assert not module.tag_matches("pandion-v0.1.0", "0.1.0")
    assert not module.tag_matches("v0.1.0", "0.1.0")


def test_package_version_reads_pyproject():
    pyproject = ROOT / "packages" / "pandion-api" / "pyproject.toml"
    expected = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]
    assert run_check().package_version() == expected
