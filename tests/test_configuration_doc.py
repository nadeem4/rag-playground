"""docs/operations/configuration.md lists every environment variable the code reads, and nothing else."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "operations" / "configuration.md"

NAME = re.compile(r"\b(?:RAG_PLAYGROUND|PANDION)_[A-Z0-9_]+\b")

#: Where the app and the packages read their settings. Tests and checks/ are left out on purpose.
SOURCES = [
    *(ROOT / "packages").glob("*/src/**/*.py"),
    *(ROOT / "playground" / "backend").rglob("*.py"),
    *(ROOT / "scripts").glob("*.py"),
    ROOT / "Dockerfile",
    ROOT / "docker-compose.yml",
]


def names_in_code() -> set[str]:
    found: set[str] = set()
    for path in SOURCES:
        found |= set(NAME.findall(path.read_text(encoding="utf-8")))
    return found


def names_in_table() -> set[str]:
    """The first cell of each table row, when it is a backticked variable name."""
    rows = [line for line in DOC.read_text(encoding="utf-8").splitlines() if line.startswith("|")]
    return {m.group(1) for line in rows if (m := re.match(r"\|\s*`([A-Z][A-Z0-9_]+)`", line))}


def test_every_variable_the_code_reads_is_in_the_table():
    missing = sorted(n for n in names_in_code() if n not in names_in_table())
    assert not missing, f"add these to docs/operations/configuration.md: {missing}"


def test_every_prefixed_variable_in_the_table_is_in_the_code():
    stale = sorted(n for n in names_in_table() if NAME.fullmatch(n) and n not in names_in_code())
    assert not stale, f"these are in the table but not in the code: {stale}"
