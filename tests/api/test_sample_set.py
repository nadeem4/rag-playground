"""The sample registry reads `samples/*/sample.json` and refuses a broken set."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from api import sample_set

ROOT = Path(__file__).resolve().parents[2]


def test_the_committed_set_lists_the_primer_first_then_by_name():
    names = [s.name for s in sample_set.all_samples()]
    assert names == ["chunking-primer", "scanned-notes", "table-of-figures", "two-column-report"]
    assert sample_set.default_sample().name == "chunking-primer"


def test_a_card_has_the_frontend_fields_and_the_sha():
    card = sample_set.get_sample("scanned-notes").card()
    assert set(card) == {"name", "title", "blurb", "shows", "stresses", "pages", "default", "filename", "sha"}
    assert card["filename"] == "scanned-notes.pdf"
    assert len(card["sha"]) == 64


def test_unknown_name_raises_key_error():
    with pytest.raises(KeyError):
        sample_set.get_sample("nope")


def _write(root: Path, name: str, card: dict) -> None:
    (root / name).mkdir(parents=True)
    (root / name / f"{name}.pdf").write_bytes(b"%PDF-1.4\n")
    (root / name / "questions.json").write_text("[]", encoding="utf-8")
    (root / name / "sample.json").write_text(json.dumps(card), encoding="utf-8")


def _card(name: str, default: bool) -> dict:
    return {"name": name, "title": name, "blurb": "b", "shows": "s", "stresses": "parse", "pages": 1, "default": default}


def test_two_defaults_is_an_error(tmp_path):
    _write(tmp_path, "a", _card("a", True))
    _write(tmp_path, "b", _card("b", True))
    with pytest.raises(sample_set.SampleSetError, match="default"):
        sample_set.all_samples(tmp_path)


def test_no_default_is_an_error(tmp_path):
    _write(tmp_path, "a", _card("a", False))
    with pytest.raises(sample_set.SampleSetError, match="default"):
        sample_set.all_samples(tmp_path)


def test_a_card_missing_a_field_names_the_folder(tmp_path):
    card = _card("a", True)
    del card["shows"]
    _write(tmp_path, "a", card)
    with pytest.raises(sample_set.SampleSetError, match="a/sample.json.*shows"):
        sample_set.all_samples(tmp_path)


def test_a_folder_without_a_card_is_an_error(tmp_path):
    _write(tmp_path, "a", _card("a", True))
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "b.pdf").write_bytes(b"%PDF-1.4\n")
    with pytest.raises(sample_set.SampleSetError, match="b"):
        sample_set.all_samples(tmp_path)
