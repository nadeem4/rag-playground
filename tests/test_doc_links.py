"""Every relative link and anchor in the repo's Markdown files resolves."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("check_doc_links", ROOT / "scripts" / "check_doc_links.py")
cdl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cdl)


def test_repo_docs_have_no_broken_links():
    problems = cdl.check(ROOT)
    assert not problems, "\n".join(str(p) for p in problems)


def test_the_pandion_stub_links_to_every_page():
    stub = (ROOT / "docs" / "pandion.md").read_text(encoding="utf-8")
    pages = sorted((ROOT / "docs" / "pandion").glob("*.md"))
    assert pages, "docs/pandion/ has no pages"
    missing = [p.name for p in pages if f"pandion/{p.name}" not in stub]
    assert not missing, f"docs/pandion.md does not link to: {missing}"
