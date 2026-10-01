"""By sentence (`sentence_window`): cuts only where sentences end.

The shared invariants (slice-back, offsets, provenance) run over every chunker
in `test_chunk.py`; this file checks what is particular to this strategy.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from core.artifacts import ArtifactType
from core.ports import RunContext, Stage
from plugins.chunk.sentence_window import SentenceWindowChunker
from tests.plugins.test_chunk import DOCS, _doc, mixed_doc, run

FIVE = "One is here. Two is here. Three is here. Four is here. Five is here."


def _ctx(tmp_path) -> RunContext:
    return RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)


def _apply(doc, tmp_path, **cfg):
    ctx = _ctx(tmp_path)
    out = SentenceWindowChunker().apply(
        {"doc": doc}, SentenceWindowChunker.config_model(**cfg), ctx
    )
    return out, ctx.extras.get("meta", {}).get("note")


def _five():
    return _doc([("paragraph", FIVE, None, 1)])


def _texts(cs):
    return [c.text for c in cs.chunks]


# --------------------------------------------------------------------------- #
# Wiring
# --------------------------------------------------------------------------- #


def test_declares_its_ports_and_name():
    assert SentenceWindowChunker.name == "sentence_window"
    assert SentenceWindowChunker.stage is Stage.CHUNK
    assert SentenceWindowChunker.inputs["doc"].type is ArtifactType.PARSED_DOC
    assert SentenceWindowChunker.output is ArtifactType.CHUNK_SET
    assert not getattr(SentenceWindowChunker, "prefers", None)


def test_listed_in_plugin_modules():
    from plugins import PLUGIN_MODULES

    assert "plugins.chunk.sentence_window" in PLUGIN_MODULES


def test_config_defaults():
    config = SentenceWindowChunker.config_model()
    assert config.sentences_per_chunk == 5
    assert config.overlap_sentences == 1


# --------------------------------------------------------------------------- #
# Windows
# --------------------------------------------------------------------------- #


def test_overlap_one_shares_a_sentence_between_neighbours():
    cs = run(SentenceWindowChunker, _five(), sentences_per_chunk=2, overlap_sentences=1)
    assert _texts(cs) == [
        "One is here. Two is here.",
        "Two is here. Three is here.",
        "Three is here. Four is here.",
        "Four is here. Five is here.",
    ]


def test_no_overlap_leaves_a_shorter_last_piece():
    cs = run(SentenceWindowChunker, _five(), sentences_per_chunk=2, overlap_sentences=0)
    assert _texts(cs) == [
        "One is here. Two is here.",
        "Three is here. Four is here.",
        "Five is here.",
    ]


@pytest.mark.parametrize("n,overlap", [(1, 0), (2, 1), (3, 0), (3, 2), (4, 1), (7, 3)])
def test_every_sentence_lands_in_a_piece(n, overlap):
    cs = run(SentenceWindowChunker, _five(), sentences_per_chunk=n, overlap_sentences=overlap)
    for word in ("One", "Two", "Three", "Four", "Five"):
        assert any(f"{word} is here." in t for t in _texts(cs))


@pytest.mark.parametrize("name", sorted(DOCS))
def test_text_is_an_exact_slice(name):
    cs = run(SentenceWindowChunker, DOCS[name](), sentences_per_chunk=2, overlap_sentences=1)
    for chunk in cs.chunks:
        assert cs.source_text[chunk.start_char : chunk.end_char] == chunk.text


def test_a_heading_line_is_its_own_sentence():
    doc = _doc(
        [
            ("heading", "Results", 1, 1),
            ("paragraph", "Scores went up. Costs went down.", None, 1),
        ]
    )
    cs = run(SentenceWindowChunker, doc, sentences_per_chunk=1, overlap_sentences=0)
    assert _texts(cs) == ["# Results", "Scores went up.", "Costs went down."]


def test_pieces_carry_their_heading_path():
    doc = _doc(
        [
            ("heading", "Results", 1, 1),
            ("paragraph", "Scores went up. Costs went down.", None, 1),
        ]
    )
    cs = run(SentenceWindowChunker, doc, sentences_per_chunk=1, overlap_sentences=0)
    assert [c.heading_path for c in cs.chunks] == [["Results"]] * 3


# --------------------------------------------------------------------------- #
# Config validation
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("n,overlap", [(2, 2), (2, 3), (1, 1)])
def test_overlap_must_be_smaller_than_the_window(n, overlap):
    with pytest.raises(ValidationError) as info:
        SentenceWindowChunker.config_model(
            sentences_per_chunk=n, overlap_sentences=overlap
        )
    messages = [e["msg"] for e in info.value.errors()]
    assert messages == [
        "Overlap must be smaller than the number of sentences per chunk."
    ]
    for message in messages:
        assert "_" not in message
    # Under the overlap field, so the card shows it there.
    assert [e["loc"] for e in info.value.errors()] == [("overlap_sentences",)]


@pytest.mark.parametrize("field,value", [("sentences_per_chunk", 0), ("overlap_sentences", -1)])
def test_bounds_are_enforced(field, value):
    with pytest.raises(ValidationError):
        SentenceWindowChunker.config_model(**{field: value})


# --------------------------------------------------------------------------- #
# Run note and meta
# --------------------------------------------------------------------------- #


def test_run_note(tmp_path):
    _, note = _apply(_five(), tmp_path, sentences_per_chunk=2, overlap_sentences=1)
    assert note == (
        "Cut 5 sentences into 4 pieces of up to 2 sentences, "
        "1 shared between neighbours."
    )


def test_run_note_singulars(tmp_path):
    doc = _doc([("paragraph", "Only one sentence.", None, 1)])
    _, note = _apply(doc, tmp_path, sentences_per_chunk=1, overlap_sentences=0)
    assert note == (
        "Cut 1 sentence into 1 piece of up to 1 sentence, "
        "0 shared between neighbours."
    )


def test_no_note_on_an_empty_doc(tmp_path):
    _, note = _apply(_doc([]), tmp_path)
    assert note is None


def test_meta_fields():
    cs = run(SentenceWindowChunker, mixed_doc(), sentences_per_chunk=3, overlap_sentences=1)
    meta = cs.chunker_meta
    assert meta["chunker"] == "sentence_window"
    assert meta["sentences_per_chunk"] == 3
    assert meta["overlap_sentences"] == 1
    assert isinstance(meta["sentences"], int) and meta["sentences"] > 0


# --------------------------------------------------------------------------- #
# Words
# --------------------------------------------------------------------------- #


def test_explanation_has_no_code_names_or_dashes():
    chunker = SentenceWindowChunker()
    explanation = chunker.explain(SentenceWindowChunker.config_model())
    words = [
        SentenceWindowChunker.summary,
        explanation.settings,
        explanation.tradeoff,
    ]
    for entry in SentenceWindowChunker.learn.values():
        words.append(entry["hint"])
        words.extend(entry["more"])
    for text in words:
        assert "_" not in text
        assert "—" not in text and "–" not in text
    assert set(SentenceWindowChunker.learn) == {
        "_strategy",
        "sentences_per_chunk",
        "overlap_sentences",
    }
