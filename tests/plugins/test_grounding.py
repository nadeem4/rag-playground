"""I-19: numbering the sources, parsing the model's markers, and grounding.

The embed function is a stub with hand-set vectors, so every label is proven
against a similarity the test chose, not one a model happened to produce.
"""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from plugins.use_case._grounding import (
    Claim,
    Sentence,
    ground,
    number_sources,
    parse_answer,
)

CHUNKS = [
    SimpleNamespace(text="Alpha is first. Beta is second."),
    SimpleNamespace(text="Gamma is third."),
]


def table_of(chunks=CHUNKS):
    return number_sources(chunks)[1]


# --- number_sources -----------------------------------------------------------


def test_ids_are_chunk_dot_sentence_one_based():
    block, table = number_sources(CHUNKS)
    assert list(table) == ["1.1", "1.2", "2.1"]
    assert table["1.2"] == Sentence(chunk_index=0, start=16, end=31, text="Beta is second.")
    assert table["2.1"] == Sentence(chunk_index=1, start=0, end=15, text="Gamma is third.")
    for s in table.values():
        assert CHUNKS[s.chunk_index].text[s.start : s.end] == s.text


def test_prompt_block_shows_every_sentence_with_its_id():
    block, _ = number_sources(CHUNKS)
    assert "[1.1] Alpha is first." in block
    assert "[1.2] Beta is second." in block
    assert "[2.1] Gamma is third." in block
    assert block.index("[1.2]") < block.index("[2.1]")


def test_a_sentence_with_a_line_break_is_shown_on_one_line():
    block, table = number_sources([SimpleNamespace(text="Wrapped\nline here.")])
    assert "[1.1] Wrapped line here." in block
    assert table["1.1"].text == "Wrapped\nline here."


# --- parse_answer -------------------------------------------------------------


def test_claims_are_the_text_before_each_run_of_markers():
    claims, unknown = parse_answer(
        "Alpha comes first [1.1]. Beta and gamma follow [1.2][2.1]. A guess.",
        table_of(),
    )
    assert claims == [
        Claim(text="Alpha comes first", ids=["1.1"]),
        Claim(text=". Beta and gamma follow", ids=["1.2", "2.1"]),
        Claim(text=". A guess.", ids=[]),
    ]
    assert unknown == 0
    # Markers are stripped; the displayed text reads naturally.
    assert "".join(c.text for c in claims) == (
        "Alpha comes first. Beta and gamma follow. A guess."
    )


def test_markers_separated_by_spaces_are_one_run():
    claims, _ = parse_answer("Both hold [1.1] [2.1]", table_of())
    assert claims == [Claim(text="Both hold", ids=["1.1", "2.1"])]


def test_marker_after_the_period_keeps_the_text_intact():
    claims, _ = parse_answer("Alpha is first.[1.1] Gamma is third.[2.1]", table_of())
    assert claims == [
        Claim(text="Alpha is first.", ids=["1.1"]),
        Claim(text=" Gamma is third.", ids=["2.1"]),
    ]


def test_unknown_ids_are_counted_and_dropped():
    claims, unknown = parse_answer("Made up [9.9][1.1]. Also [3.1].", table_of())
    assert unknown == 2
    # Each claim remembers how many of its ids were invented.
    assert claims[0] == Claim(text="Made up", ids=["1.1"], invalid=1)
    assert claims[1] == Claim(text=". Also", ids=[], invalid=1)


def test_repeated_ids_in_one_run_are_listed_once():
    claims, _ = parse_answer("Alpha [1.1][1.1]", table_of())
    assert claims == [Claim(text="Alpha", ids=["1.1"])]


def test_an_answer_with_no_markers_is_one_claim():
    claims, unknown = parse_answer("No markers at all.", table_of())
    assert claims == [Claim(text="No markers at all.", ids=[])] and unknown == 0


def test_empty_answer_has_no_claims():
    assert parse_answer("", table_of()) == ([], 0)


# --- ground -------------------------------------------------------------------


VECTORS = {
    "Alpha is first.": [1.0, 0.0, 0.0],
    "Beta is second.": [0.0, 1.0, 0.0],
    "Gamma is third.": [0.0, 0.0, 1.0],
    "about alpha": [1.0, 0.0, 0.0],
    "near alpha": [0.8, 0.6, 0.0],
    "mostly unrelated": [0.3, 0.3, 0.1, 0.9],
    "unscaled alpha": [5.0, 0.0, 0.0],
}


def stub_embed(calls=None):
    def embed(texts):
        if calls is not None:
            calls.append(list(texts))
        return [VECTORS[t.strip(" .")] if t.strip(" .") in VECTORS else VECTORS[t] for t in texts]

    return embed


def test_every_label_and_its_citations():
    table = table_of()
    claims = [
        Claim(text="about alpha", ids=["1.1"]),  # cites the right sentence
        Claim(text=". about alpha", ids=["1.2"]),  # cites an unrelated one
        Claim(text=" near alpha", ids=[]),  # no ids, but close to 1.1
        Claim(text=" mostly unrelated", ids=[]),  # no ids, close to nothing
    ]
    out = ground(claims, table, stub_embed(), threshold=0.55)
    assert [g.label for g in out] == ["cited", "weak", "similarity", "none"]
    assert out[0].citations == [("1.1", pytest.approx(1.0))]
    assert out[1].citations == [("1.2", pytest.approx(0.0))]
    assert out[2].citations == [("1.1", pytest.approx(0.8))]
    assert out[3].citations == []
    assert [g.text for g in out] == [c.text for c in claims]


def test_cited_uses_the_best_of_several_ids():
    out = ground([Claim(text="about alpha", ids=["1.2", "1.1"])], table_of(), stub_embed(), 0.55)
    [g] = out
    assert g.label == "cited"
    assert g.citations == [("1.2", pytest.approx(0.0)), ("1.1", pytest.approx(1.0))]


def test_the_threshold_decides_cited_against_weak():
    claim = [Claim(text="near alpha", ids=["1.1"])]
    assert ground(claim, table_of(), stub_embed(), 0.8)[0].label == "cited"
    assert ground(claim, table_of(), stub_embed(), 0.81)[0].label == "weak"


def test_similarity_threshold_is_inclusive_too():
    claim = [Claim(text="near alpha", ids=[])]
    assert ground(claim, table_of(), stub_embed(), 0.8)[0].label == "similarity"
    assert ground(claim, table_of(), stub_embed(), 0.81)[0].label == "none"


def test_a_claim_whose_only_ids_were_invented_is_not_rescued_by_similarity():
    # The model tried to cite and made the id up: flag it, don't match it.
    claim = [Claim(text="near alpha", ids=[], invalid=1)]
    [g] = ground(claim, table_of(), stub_embed(), 0.55)
    assert g.label == "none" and g.citations == []


def test_vectors_are_normalised_before_the_cosine():
    [g] = ground([Claim(text="unscaled alpha", ids=["1.1"])], table_of(), stub_embed(), 0.99)
    assert g.label == "cited"
    assert math.isclose(g.citations[0][1], 1.0)


def test_punctuation_only_pieces_are_not_claims():
    calls: list = []
    out = ground([Claim(text=". ", ids=[])], table_of(), stub_embed(calls), 0.55)
    assert out[0].label is None and out[0].citations == []
    assert all(". " not in batch for batch in calls)


def test_embeds_in_one_batch_per_side():
    calls: list = []
    ground(
        [Claim(text="about alpha", ids=["1.1"]), Claim(text="near alpha", ids=[])],
        table_of(),
        stub_embed(calls),
        0.55,
    )
    assert len(calls) == 2
