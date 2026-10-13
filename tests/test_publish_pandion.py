"""The workflow that publishes pandion to PyPI, and the install check it runs first.

PyPI trusts exactly one workflow for `pandion`: `publish-pandion.yml` in this repo,
in the `pypi` environment. A rename of either breaks publishing, so both are pinned.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "publish-pandion.yml"


def workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def triggers(wf: dict) -> dict:
    return wf.get("on", wf.get(True))  # YAML reads a bare `on` as True


def run_check():
    spec = importlib.util.spec_from_file_location(
        "run_check", ROOT / "checks" / "pandion-install" / "run_check.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_it_runs_only_on_a_pandion_tag():
    assert triggers(workflow()) == {"push": {"tags": ["pandion-v*"]}}


def test_publishing_waits_for_the_install_check_and_uses_the_pypi_environment():
    publish = workflow()["jobs"]["publish"]
    assert publish["needs"] == "build"
    assert publish["environment"]["name"] == "pypi"
    assert publish["permissions"] == {"id-token": "write"}
    uses = [step.get("uses", "") for step in publish["steps"]]
    assert any(u.startswith("pypa/gh-action-pypi-publish@") for u in uses)


def test_the_build_checks_the_tag_and_the_wheel_it_uploads():
    steps = " ".join(step.get("run", "") for step in workflow()["jobs"]["build"]["steps"])
    assert "run_check.py --wheel" in steps
    assert "--tag" in steps


def test_the_tag_must_match_the_package_version():
    module = run_check()
    assert module.tag_matches("pandion-v0.1.0", "0.1.0")
    assert not module.tag_matches("pandion-v0.1.1", "0.1.0")
    assert not module.tag_matches("v0.1.0", "0.1.0")


def test_the_check_tests_a_given_wheel_without_building_one(tmp_path, monkeypatch):
    module = run_check()
    wheel = tmp_path / "pandion-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"")
    built, checked = [], []
    monkeypatch.setattr(module, "run", lambda *args, **kwargs: built.append(args))
    monkeypatch.setattr(module, "check", lambda work, w, *rest: checked.append(w) or 0)
    examples = []
    monkeypatch.setattr(module, "run_own_strategies", lambda work, venv: examples.append(venv) or 0)
    assert module.main(tmp_path / "work", with_models=False, wheel=wheel) == 0
    assert built == []
    assert checked == [wheel, wheel]
    # The own-strategies example runs with the first environment, which has the extras.
    assert examples == [tmp_path / "work" / "venv"]


def test_the_check_fails_when_the_own_strategies_example_fails(tmp_path, monkeypatch):
    module = run_check()
    wheel = tmp_path / "pandion-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"")
    monkeypatch.setattr(module, "check", lambda *args: 0)
    monkeypatch.setattr(module, "run_own_strategies", lambda work, venv: 1)
    assert module.main(tmp_path / "work", with_models=False, wheel=wheel) == 1
