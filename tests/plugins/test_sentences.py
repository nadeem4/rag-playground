"""I-19: the sentence splitter behind sentence-id citations.

The contract every case checks: ranges are in order, never overlap, are trimmed
of surrounding whitespace, and `text[s:e]` is the sentence exactly.
"""

from __future__ import annotations

import pytest

from plugins.use_case._sentences import split_sentences


def sentences(text: str) -> list[str]:
    ranges = split_sentences(text)
    # The invariants, for every input.
    prev_end = 0
    for s, e in ranges:
        assert prev_end <= s < e <= len(text)
        piece = text[s:e]
        assert piece == piece.strip() and piece
        # Only whitespace is ever skipped between sentences.
        assert text[prev_end:s].strip() == ""
        prev_end = e
    assert text[prev_end:].strip() == ""
    return [text[s:e] for s, e in ranges]


def test_empty_and_blank_text_have_no_sentences():
    assert split_sentences("") == []
    assert split_sentences("   \n\n  ") == []


def test_plain_sentences():
    assert sentences("One is here. Two is here! Three is here? Four.") == [
        "One is here.",
        "Two is here!",
        "Three is here?",
        "Four.",
    ]


def test_round_trip_offsets_are_exact():
    text = "  Leading space. Then more.  "
    ranges = split_sentences(text)
    assert ranges == [(2, 16), (17, 27)]
    assert [text[s:e] for s, e in ranges] == ["Leading space.", "Then more."]


@pytest.mark.parametrize(
    "text",
    [
        "Use a separator, e.g. a blank line, to split. It works.",
        "Split on structure, i.e. headings, first. It works.",
        "Ask Dr. Smith about it. It works.",
        "Mr. Jones and Mrs. Jones agree. It works.",
        "Apples, pears, etc. are fruit. It works.",
        "Compare A vs. B carefully. It works.",
        "See Fig. 3 for the curve. It works.",
        "Smith et al. showed this. It works.",
    ],
)
def test_abbreviations_do_not_end_a_sentence(text):
    first, second = sentences(text)
    assert second == "It works."
    assert first == text[: text.index(" It works.")]


def test_decimals_do_not_end_a_sentence():
    assert sentences("The ratio is 3.5 on average. Version 2.0.1 shipped.") == [
        "The ratio is 3.5 on average.",
        "Version 2.0.1 shipped.",
    ]


def test_initials_do_not_end_a_sentence():
    assert sentences("J. R. R. Tolkien wrote it. So did C. S. Lewis.") == [
        "J. R. R. Tolkien wrote it.",
        "So did C. S. Lewis.",
    ]


def test_dotted_acronyms_do_not_end_a_sentence():
    assert sentences("It shipped in the U.S. before Europe. Then it spread.") == [
        "It shipped in the U.S. before Europe.",
        "Then it spread.",
    ]


def test_each_list_item_is_one_sentence():
    text = "Steps:\n- Parse the file. Keep the layout.\n- Chunk it\n* Index it\n1. Ask\n2. Answer."
    assert sentences(text) == [
        "Steps:",
        "- Parse the file. Keep the layout.",
        "- Chunk it",
        "* Index it",
        "1. Ask",
        "2. Answer.",
    ]


def test_a_wrapped_list_item_stays_one_sentence():
    text = "- A long item that\n  wraps. Onto two lines\n- Next item\n\nProse."
    assert sentences(text) == [
        "- A long item that\n  wraps. Onto two lines",
        "- Next item",
        "Prose.",
    ]


def test_each_table_row_is_one_sentence():
    text = "| name | size |\n| --- | --- |\n| a. b | 1.5 |\nAfter the table."
    assert sentences(text) == [
        "| name | size |",
        "| --- | --- |",
        "| a. b | 1.5 |",
        "After the table.",
    ]


def test_trailing_text_without_a_final_period_is_a_sentence():
    assert sentences("First one. And a trailing fragment") == [
        "First one.",
        "And a trailing fragment",
    ]


def test_multiple_spaces_and_newlines_between_sentences():
    text = "First one.    Second one.\n\n\nThird one.\n   Fourth one."
    assert sentences(text) == ["First one.", "Second one.", "Third one.", "Fourth one."]


def test_a_wrapped_line_inside_a_paragraph_does_not_split():
    text = "A sentence that wraps\nonto a second line. Next."
    assert sentences(text) == ["A sentence that wraps\nonto a second line.", "Next."]


def test_paragraph_breaks_end_a_sentence_even_without_a_period():
    assert sentences("# A heading\n\nBody text here.") == ["# A heading", "Body text here."]


def test_closing_quotes_and_brackets_stay_with_their_sentence():
    assert sentences('He said "stop." Then (it ended.) Later.') == [
        'He said "stop."',
        "Then (it ended.)",
        "Later.",
    ]


def test_lowercase_after_a_period_prefers_the_longer_sentence():
    assert sentences("It costs approx. five dollars. Done.") == [
        "It costs approx. five dollars.",
        "Done.",
    ]


def test_a_number_ending_a_sentence_still_splits():
    assert sentences("It grew in 2024. Then it slowed.") == [
        "It grew in 2024.",
        "Then it slowed.",
    ]
