"""I-22: GET /api/learn/chunking, proven against the real chunkers.

Fast: pdfium parses the committed sample and the chunkers run in-process. No
model loads, no network.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core.ports import RunContext, Stage
from core.registry import registry
from plugins.chunk import DocView, count_tokens

SAMPLE = Path(__file__).resolve().parents[2] / "samples" / "chunking-primer.pdf"


@pytest.fixture
def body(client) -> dict:
    r = client.get("/api/learn/chunking")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def document(client) -> dict:
    r = client.get("/api/learn/document")
    assert r.status_code == 200, r.text
    return r.json()


def _parse(body: dict, tmp_path: Path) -> dict:
    parse = body["parse"]
    cls = registry.get(Stage.PARSE, parse["transform"])
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    return cls().apply(
        {"file": {"path": str(SAMPLE), "sha": "sample", "filename": SAMPLE.name}},
        cls.config_model(**parse["config"]),
        ctx,
    )


def test_learn_chunking_has_the_i22_shape(body):
    assert set(body) == {
        "question",
        "answer_sentence",
        "sentence_chars",
        "sentence_tokens",
        "parse",
        "challenges",
    }
    assert body["question"] == "Why do chunk boundaries matter?"
    assert body["parse"] == {"transform": "pdfium", "config": {}}
    assert len(body["challenges"]) == 4
    for challenge in body["challenges"]:
        assert set(challenge) == {"id", "title", "strategy", "config", "expect_whole"}


def test_sentence_lengths_are_counted_the_way_each_chunker_counts(body):
    sentence = body["answer_sentence"]
    assert body["sentence_chars"] == len(sentence)
    assert body["sentence_tokens"] == count_tokens(sentence)


def test_challenges_follow_the_story(body):
    first, second, third, fourth = body["challenges"]
    chars, tokens = body["sentence_chars"], body["sentence_tokens"]

    assert first["strategy"] == second["strategy"] == "recursive_character"
    assert first["config"]["chunk_size"] < chars
    assert second["config"]["chunk_size"] == 300
    assert [first["expect_whole"], second["expect_whole"]] == [False, True]

    assert third["strategy"] == fourth["strategy"] == "token_based"
    assert third["config"]["max_tokens"] == fourth["config"]["max_tokens"]
    assert third["config"]["overlap"] == 0
    assert fourth["config"]["overlap"] > tokens
    # A sensible share of the chunk, not barely above the overlap.
    assert fourth["config"]["max_tokens"] >= 3 * tokens - 5
    assert [third["expect_whole"], fourth["expect_whole"]] == [False, True]


def test_answer_sentence_is_verbatim_in_the_parsed_sample(body, tmp_path):
    text = DocView.of(_parse(body, tmp_path)).text
    assert text.count(body["answer_sentence"]) == 1


def test_every_challenge_outcome_holds_on_the_real_chunkers(body, tmp_path):
    doc = _parse(body, tmp_path)
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    for challenge in body["challenges"]:
        cls = registry.get(Stage.CHUNK, challenge["strategy"])
        chunks = cls().apply(
            {"doc": doc}, cls.config_model(**challenge["config"]), ctx
        ).chunks
        whole = any(body["answer_sentence"] in c.text for c in chunks)
        assert whole is challenge["expect_whole"], challenge["id"]


def test_learn_document_is_the_sample_the_lessons_use(document):
    assert set(document) == {"filename", "page_count", "text"}
    assert document["filename"] == "chunking-primer.pdf"
    assert document["page_count"] == 3


def test_learn_document_text_is_what_the_chunkers_cut(document, body, tmp_path):
    """The Text view must show the same text the chunk steps work on."""
    assert document["text"] == DocView.of(_parse(body, tmp_path)).text
    assert body["answer_sentence"] in document["text"]
