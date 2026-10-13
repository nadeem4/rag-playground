"""TEMPORARY: print why heading-sections misses on Linux. Remove before merge."""
import pytest

from pandion.artifacts import ArtifactType
from pandion.plugins.chunk import DocView
from tests.test_sample_plants import Runner, _has, _questions


@pytest.mark.models
def test_tmp_dump_heading_sections(tmp_path, monkeypatch):
    runner = Runner("chunking-primer", tmp_path, monkeypatch)
    q = next(q for q in _questions("chunking-primer") if q["id"] == "heading-sections")
    payload, result = runner.ask(q)
    print("PAYLOAD", payload)
    print("LOST_AT", runner.lost_at(q, result))
    doc = runner.load(result, "clean", ArtifactType.PARSED_DOC)
    for el in doc["elements"]:
        if el.get("page") == 3:
            print("BLOCK", repr(el.get("text", "")))
    for i, c in enumerate(runner.pieces(result)):
        if "heading" in c["text"] and "subject" in c["text"] or _has(c["text"], q):
            print("PIECE", i, repr(c["text"]))
    assert False, "debug dump"
