"""What PyPI gets for pandion-api: metadata, the Pandion range, the publish workflow, the runbook."""

from __future__ import annotations

import tomllib
from pathlib import Path

from packaging.requirements import Requirement

import pandion
import pandion_api

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
PROJECT = tomllib.loads((PACKAGE / "pyproject.toml").read_text(encoding="utf-8"))["project"]


def pandion_requirement() -> Requirement:
    return next(r for r in map(Requirement, PROJECT["dependencies"]) if r.name == "pandion")


def test_version_in_pyproject_equals_the_module_version():
    assert PROJECT["version"] == pandion_api.__version__


def test_no_private_classifier():
    assert not any(c.startswith("Private ::") for c in PROJECT.get("classifiers", []))


def test_pandion_dependency_declares_a_range():
    ops = {spec.operator for spec in pandion_requirement().specifier}
    assert ">=" in ops and "<" in ops


def test_workspace_pandion_is_inside_the_declared_range():
    assert pandion_requirement().specifier.contains(pandion.__version__)


def test_extras_otel_and_metrics_still_declared():
    assert {"otel", "metrics"} <= set(PROJECT["optional-dependencies"])


def test_readme_is_declared_and_exists():
    assert PROJECT["readme"] == "README.md"
    assert (PACKAGE / "README.md").is_file()
