"""The web's chunk set fixtures carry the stats pandion-api serves with them,
worked out by `pandion.chunk.stats`, and those numbers are the ones the web
used to work out itself."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import pandion

FIXTURES = Path(__file__).resolve().parents[2] / "playground" / "frontend" / "src" / "api" / "fixtures"


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("chunk_set.*.json")), ids=lambda p: p.stem)
def test_each_chunk_set_fixture_carries_pandions_stats(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    stats = data.pop("stats")
    assert stats == pandion.chunk.stats(data)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # The numbers the web's chunk inspector showed for these fixtures.
        ("recursive_character", {"pieces": 6, "tokens": 399, "median_tokens": 67, "p95_tokens": 76, "overlaps": 3, "uncovered": 4}),
        ("markdown_header", {"pieces": 5, "tokens": 388, "median_tokens": 70, "p95_tokens": 119, "overlaps": 0, "uncovered": 8}),
    ],
)
def test_the_numbers_are_the_ones_the_web_showed(name, expected):
    data = json.loads((FIXTURES / f"chunk_set.{name}.json").read_text(encoding="utf-8"))
    stats = pandion.chunk.stats(data)
    assert {k: stats[k] for k in expected} == expected
