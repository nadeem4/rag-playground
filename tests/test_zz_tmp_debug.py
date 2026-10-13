"""TEMPORARY: rank candidate wordings of heading-sections on Linux. Remove before merge."""
import pytest

from tests.test_sample_plants import Runner, _questions

CANDIDATES = [
    "Why does structure-aware splitting cut at headings?",
    "Why is a section under one heading a good chunk?",
    "What does a section under one heading usually discuss?",
    "Why do headings make good places to cut a document into chunks?",
    "Why is a heading a natural place to start a new chunk?",
    "What makes the text under one heading a good chunk?",
]


@pytest.mark.models
def test_tmp_rank_candidates(tmp_path, monkeypatch):
    runner = Runner("chunking-primer", tmp_path, monkeypatch)
    base = next(q for q in _questions("chunking-primer") if q["id"] == "heading-sections")
    for text in CANDIDATES:
        payload, _ = runner.ask({**base, "question": text})
        print("RANK", repr(text), payload["hit"], payload["rank"], payload.get("found_at"))
    assert False, "debug dump"
