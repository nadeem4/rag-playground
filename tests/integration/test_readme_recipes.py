"""The README recipes for the Stable extension points point at real, tested examples."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
README = (ROOT / "packages" / "pandion" / "README.md").read_text(encoding="utf-8")
API_README = (ROOT / "packages" / "pandion-api" / "README.md").read_text(encoding="utf-8")
LINK = re.compile(r"\]\(https://github\.com/nadeem4/rag-playground/(?:blob|tree)/main/([^)#]+)")
#: The Stable points that have a tested example today. The conversation store waits for its store.
WITH_RECIPE = ("Source", "Route check", "Access rule", "Index store", "Policy")


def section() -> str:
    start = README.index("## Extend Pandion")
    end = README.find("\n## ", start + 1)
    return README[start:end if end != -1 else None]


def test_every_stable_point_in_the_readme_links_a_file_that_exists():
    rows = {
        cells[0]: cells
        for cells in ([c.strip() for c in line.strip("|").split("|")] for line in section().splitlines() if line.startswith("|"))
        if len(cells) == 3
    }
    for point in WITH_RECIPE:
        links = LINK.findall(rows[point][2])
        assert links, f"the {point} row links no example"
        for target in links:
            assert (ROOT / target).exists(), f"{point}: {target} does not exist"
    assert "Conversation store" in rows


def test_each_recipe_names_the_registered_name_of_its_example():
    text = section()
    for name in ("zip", "team_from_path", "json_file", "is_invoice"):
        assert f"`{name}`" in text, name
    assert "policy_example.py" in API_README and "SizeLimitedPolicy" in API_README
