"""No public doc describes a route, a variable or a shape that part 5 removed."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Public docs. docs/lessons-learned.md is left out: it is a record of what happened, in the words of the time.
DOCS = sorted(
    {ROOT / "README.md", ROOT / "CONTRIBUTING.md"}
    | {p for p in (ROOT / "docs").glob("*.md") if p.name != "lessons-learned.md"}
    | set((ROOT / "examples").rglob("*.md"))
    | set((ROOT / "packages").glob("*/README.md"))
)

GONE = [
    re.compile(r"/api/(runs|sweeps|registry|explain|artifacts|cache|trace)\b"),
    re.compile(r"/api/settings/llm\b"),
    re.compile(r"/api/sources(?!/sample)\b"),
    re.compile(r"RAG_PLAYGROUND_EMBED_CACHE"),
    re.compile(r"\bgraph of (nodes|steps)\b.*\b(browser|web app|saved)\b", re.IGNORECASE),
]


def test_no_public_doc_names_what_part_5_removed():
    hits = [
        f"{doc.relative_to(ROOT)}:{n}: {line.strip()}"
        for doc in DOCS
        for n, line in enumerate(doc.read_text(encoding="utf-8").splitlines(), start=1)
        if any(rx.search(line) for rx in GONE)
    ]
    assert not hits, "these lines describe what part 5 removed:\n" + "\n".join(hits)


def test_the_docs_name_the_cli_commands():
    text = (ROOT / "docs" / "pandion.md").read_text(encoding="utf-8")
    for command in ("validate", "strategies", "index", "retrieve", "ask", "eval", "compare", "install"):
        assert f"pandion {command}" in text, f"docs/pandion.md does not show `pandion {command}`"
