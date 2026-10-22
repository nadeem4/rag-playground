"""`pandion.chunk.stats`: the numbers that sum up a chunk set, in the unit its
chunker's size setting counts in, so every app says them the same way."""

from __future__ import annotations

import pandion
from pandion.payloads import Chunk, ChunkSet


def chunk_set(source: str, spans: list[tuple[int, int]], chunker: str = "token_based") -> ChunkSet:
    chunks = [
        Chunk(id=f"c{i}", text=source[a:b], start_char=a, end_char=b, token_count=len(source[a:b].split()))
        for i, (a, b) in enumerate(spans)
    ]
    return ChunkSet(chunks=chunks, source_text=source, chunker_meta={"chunker": chunker})


SOURCE = "one two three four five six seven eight nine ten"


def test_pieces_tokens_overlaps_and_what_no_piece_covers():
    s = pandion.chunk.stats(chunk_set(SOURCE, [(0, 13), (8, 23), (24, 33)]))
    assert (s["pieces"], s["tokens"]) == (3, 3 + 3 + 2)
    assert s["overlaps"] == 1  # "three" is in the first two
    assert s["uncovered"] == len(SOURCE) - 33 + 1  # the space at 23, and the tail


def test_sizes_are_in_the_unit_the_chunker_counts_in():
    tokens = pandion.chunk.stats(chunk_set(SOURCE, [(0, 3), (4, 13)]))
    assert (tokens["unit"], tokens["median"], tokens["largest"]) == ("tokens", 1.5, 2)
    chars = pandion.chunk.stats(chunk_set(SOURCE, [(0, 3), (4, 13)], chunker="recursive_character"))
    assert (chars["unit"], chars["median"], chars["largest"]) == ("characters", 6.0, 9)
    # In tokens whatever the unit.
    assert (chars["median_tokens"], chars["p95_tokens"]) == (1.5, 2)


def test_p95_is_a_size_that_occurs():
    s = pandion.chunk.stats(chunk_set(" ".join(["w"] * 40), [(2 * i, 2 * i + 1) for i in range(20)]))
    assert s["p95"] == 1
    sizes = list(range(1, 21))
    text = " ".join("x" * n for n in sizes)
    spans, at = [], 0
    for n in sizes:
        spans.append((at, at + n))
        at += n + 1
    assert pandion.chunk.stats(chunk_set(text, spans, chunker="recursive_character"))["p95"] == 19


def test_an_empty_set_has_no_sizes_and_an_unknown_chunker_counts_tokens():
    s = pandion.chunk.stats(chunk_set(SOURCE, [], chunker="nobody"))
    assert s == {
        "pieces": 0, "tokens": 0, "unit": "tokens", "median": None, "p95": None, "largest": None,
        "median_tokens": None, "p95_tokens": None, "overlaps": 0, "uncovered": len(SOURCE),
    }


def test_offsets_outside_the_source_are_clamped_and_an_empty_piece_covers_nothing():
    s = pandion.chunk.stats(chunk_set(SOURCE, [(0, 3), (3, 3)]).model_copy(update={"source_text": "one"}))
    assert (s["overlaps"], s["uncovered"]) == (0, 0)


def test_it_reads_a_payload_as_stored():
    assert pandion.chunk.stats(chunk_set(SOURCE, [(0, 13)]).model_dump(mode="json"))["pieces"] == 1


def test_each_chunker_says_its_unit():
    from pandion.plugins import discover
    from pandion.plugins.chunk import size_unit
    from pandion.ports import Stage
    from pandion.registry import registry

    discover()
    units = {name: size_unit(name) for name in registry.all_for(Stage.CHUNK)}
    assert units["recursive_character"] == "characters"
    assert units["token_based"] == "tokens"
    assert set(units.values()) <= {"characters", "tokens"}


def test_p95_by_nearest_rank_on_an_uneven_set():
    from pandion.plugins.chunk import _p95

    assert _p95([69, 69, 75, 69, 73, 75, 37]) == 75
    assert _p95(list(range(1, 21))) == 19


def test_a_unit_other_than_characters_or_tokens_is_said_as_tokens(monkeypatch):
    # A plugin chunker that says "words" still gets token counts, so the label says tokens.
    from pandion.registry import registry

    class Words:
        size_unit = "words"

    monkeypatch.setattr(registry, "get", lambda stage, name: Words)
    s = pandion.chunk.stats(chunk_set(SOURCE, [(0, 3), (4, 13)], chunker="words_plugin"))
    assert (s["unit"], s["median"], s["largest"]) == ("tokens", 1.5, 2)
