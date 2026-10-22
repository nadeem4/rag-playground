"""What PyPI shows for pandion: the version, the page, the license and the links."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pandion

ROOT = Path(__file__).resolve().parents[1]
PROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]


def test_the_version_is_the_same_in_the_package_and_its_settings():
    assert PROJECT["version"] == pandion.__version__ == "0.5.0"


def test_the_package_page_is_its_own_readme():
    assert PROJECT["readme"] == "README.md"
    assert (ROOT / "README.md").is_file()


def test_the_readme_links_work_on_pypi():
    """PyPI shows the README away from the repo, so a relative link would break there."""
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    links = re.findall(r"\]\(([^)]+)\)", text)
    assert links
    assert [link for link in links if not link.startswith("https://")] == []


def test_the_license_ships_with_the_package():
    assert PROJECT["license"] == "MIT"
    assert PROJECT["license-files"] == ["LICENSE"]
    assert (ROOT / "LICENSE").is_file()


def test_pypi_links_to_the_repo_and_the_guide():
    assert set(PROJECT["urls"]) == {"Homepage", "Documentation", "Source", "Issues"}
