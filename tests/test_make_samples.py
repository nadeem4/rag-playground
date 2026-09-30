"""The sample set is generated, byte for byte, by `scripts/make_samples.py`."""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

make_samples = importlib.import_module("scripts.make_samples")


@pytest.mark.parametrize("gen", make_samples.GENERATORS, ids=lambda g: g.NAME)
def test_build_is_byte_stable(gen):
    assert gen.build() == gen.build()


@pytest.mark.parametrize("gen", make_samples.GENERATORS, ids=lambda g: g.NAME)
def test_committed_pdf_matches_the_generator(gen):
    committed = ROOT / "samples" / gen.NAME / f"{gen.NAME}.pdf"
    assert committed.read_bytes() == gen.build(), (
        f"run `uv run python scripts/make_samples.py` and commit {committed}"
    )


@pytest.mark.parametrize("gen", make_samples.GENERATORS, ids=lambda g: g.NAME)
def test_every_sample_folder_is_complete(gen):
    folder = ROOT / "samples" / gen.NAME
    card = json.loads((folder / "sample.json").read_text(encoding="utf-8"))
    assert card["name"] == gen.NAME
    assert set(card) == {"name", "title", "blurb", "shows", "stresses", "pages", "default"}
    assert card["stresses"] in {"parse", "clean", "chunk", "index", "retrieve"}
    questions = json.loads((folder / "questions.json").read_text(encoding="utf-8"))
    assert questions and all(set(q) >= {"id", "question", "gold_answer"} for q in questions)


def test_exactly_one_sample_is_the_default():
    defaults = [
        g.NAME
        for g in make_samples.GENERATORS
        if json.loads((ROOT / "samples" / g.NAME / "sample.json").read_text(encoding="utf-8"))["default"]
    ]
    assert defaults == ["chunking-primer"]
