"""What PyPI gets for pandion-api: metadata, the Pandion range, the publish workflow, the runbook."""

from __future__ import annotations

import fnmatch
import re
import tomllib
from pathlib import Path

import yaml
from packaging.requirements import Requirement

import pandion
import pandion_api

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
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


def workflow() -> dict:
    return yaml.safe_load((WORKFLOWS / "publish-pandion-api.yml").read_text(encoding="utf-8"))


def test_workflow_triggers_only_on_pandion_api_tags():
    wf = workflow()
    assert wf.get("on", wf.get(True)) == {"push": {"tags": ["pandion-api-v*"]}}


def test_tag_patterns_do_not_overlap():
    patterns = ["v*", "pandion-v*", "pandion-api-v*"]

    def hits(tag: str) -> list[str]:
        return [p for p in patterns if fnmatch.fnmatchcase(tag, p)]

    assert hits("pandion-api-v0.1.0") == ["pandion-api-v*"]
    assert hits("pandion-v0.8.0") == ["pandion-v*"]
    assert hits("v0.1.0") == ["v*"]


def test_publish_job_uses_the_pypi_environment_and_oidc():
    publish = workflow()["jobs"]["publish"]
    assert publish["needs"] == "build"
    assert publish["environment"]["name"] == "pypi"
    assert publish["permissions"] == {"id-token": "write"}
    assert any(s.get("uses", "").startswith("pypa/gh-action-pypi-publish@") for s in publish["steps"])


def test_workflow_builds_both_wheels_and_runs_the_check():
    steps = " ".join(s.get("run", "") for s in workflow()["jobs"]["build"]["steps"])
    assert "uv build packages/pandion " in steps
    assert "uv build packages/pandion-api " in steps
    assert "pandion-api-install/run_check.py" in steps and "--tag" in steps


def test_publish_uploads_only_pandion_api_files():
    steps = " ".join(s.get("run", "") for s in workflow()["jobs"]["publish"]["steps"])
    assert "rm" in steps and "dist/pandion-[0-9]*" in steps


def test_runbook_names_the_api_tag_and_workflow():
    release = (ROOT / "docs" / "operations" / "release.md").read_text(encoding="utf-8")
    assert "pandion-api-v" in release
    assert "publish-pandion-api.yml" in release
    assert "owner's explicit yes" in release
    contributing = (ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8")
    assert "not published" not in contributing


def test_the_readme_links_work_on_pypi():
    """PyPI shows the README away from the repo, so a relative link would break there."""
    text = (PACKAGE / "README.md").read_text(encoding="utf-8")
    links = re.findall(r"\]\(([^)]+)\)", text)
    assert links
    assert [link for link in links if not link.startswith("https://")] == []


def test_the_license_ships_with_the_package():
    assert PROJECT["license"] == "MIT"
    assert PROJECT["license-files"] == ["LICENSE"]
    pandion_license = (ROOT / "packages" / "pandion" / "LICENSE").read_text(encoding="utf-8")
    assert (PACKAGE / "LICENSE").read_text(encoding="utf-8") == pandion_license


def test_the_publish_action_is_pinned_to_a_commit():
    publish = workflow()["jobs"]["publish"]["steps"]
    uses = next(s["uses"] for s in publish if "pypi-publish" in s.get("uses", ""))
    assert re.fullmatch(r"pypa/gh-action-pypi-publish@[0-9a-f]{40}", uses)
    checkout = next(s for s in workflow()["jobs"]["build"]["steps"] if s.get("uses", "").startswith("actions/checkout"))
    assert checkout["with"]["persist-credentials"] is False


def test_docs_say_pandion_api_installs_from_pypi():
    for path in ("README.md", "CONTRIBUTING.md", "docs/pandion-api/index.md"):
        text = (ROOT / path).read_text(encoding="utf-8")
        assert "pip install pandion-api" in text, path
        assert "until then" not in text and "not yet)" not in text and "once published" not in text, path
