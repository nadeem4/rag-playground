"""Split text into sentences, as exact character ranges (I-19).

Used by sentence-id grounding: every retrieved chunk is cut into sentences, each
gets an id the model can cite, and a cited id maps straight back to a range of
the chunk's text. So the ranges must be exact: `text[s:e]` is the sentence,
trimmed of surrounding whitespace, in order and never overlapping.

Two passes. First the text is cut into *units* at structure: a blank line, and
every line that is a list item, a table row or a heading. A list item or a table
row is one sentence, whatever punctuation it holds. Then each ordinary unit is
cut at `.`, `!` or `?` followed by whitespace and a capital, digit, quote or
bracket, unless the word before the stop is an abbreviation ("e.g.", "Dr."), an
initial ("J."), a dotted acronym ("U.S.") or a list number at the start of the
unit ("1."). Decimals never split, because no whitespace follows their point.

When unsure it keeps the longer sentence: a missed split only makes a citation
cover a little more text, while a wrong one cuts a claim's evidence in half.
"""

from __future__ import annotations

import re

#: Lower-cased words that end with a period but do not end a sentence.
ABBREVIATIONS = frozenset(
    """
    e.g i.e etc vs cf al approx dr mr mrs ms prof sr jr st fig figs eq eqs no
    nos vol pp p ch sec inc ltd co corp dept est jan feb mar apr jun jul aug sep
    sept oct nov dec
    """.split()
)

_LIST_ITEM = re.compile(r"[ \t]*(?:[-*+•]|\d{1,3}[.)]|[a-z][.)]|[A-Z]\))\s")
_TABLE_ROW = re.compile(r"[ \t]*\|")
_HEADING = re.compile(r"[ \t]*#{1,6}\s")
#: A sentence stop, any closing quotes or brackets, then the whitespace after.
_STOP = re.compile(r"[.!?]+[\"'”’)\]]*(?=\s)")
_STARTS_SENTENCE = re.compile(r"[A-Z0-9\"'“‘(\[]")


def split_sentences(text: str) -> list[tuple[int, int]]:
    """(start, end) of every sentence in `text`, in order."""
    out: list[tuple[int, int]] = []
    for start, end, whole in _units(text):
        if whole:
            _add(out, text, start, end)
        else:
            _split_prose(out, text, start, end)
    return out


def _units(text: str) -> list[tuple[int, int, bool]]:
    """(start, end, whole) blocks. `whole` means the block is one sentence."""
    units: list[tuple[int, int, bool]] = []
    start: int | None = None  # the open prose unit, if any

    def close(at: int) -> None:
        nonlocal start
        if start is not None:
            units.append((start, at, False))
            start = None

    pos = 0
    item_open = False  # the last unit is a list item a wrapped line may continue
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        line_start, line_end = pos, pos + len(body)
        pos += len(line)
        if not body.strip():
            close(line_start)
            item_open = False
        elif _LIST_ITEM.match(body) or _TABLE_ROW.match(body) or _HEADING.match(body):
            close(line_start)
            units.append((line_start, line_end, True))
            item_open = bool(_LIST_ITEM.match(body))
        elif item_open:
            units[-1] = (units[-1][0], line_end, True)
        elif start is None:
            start = line_start
    close(len(text))
    return units


def _split_prose(out: list[tuple[int, int]], text: str, start: int, end: int) -> None:
    unit = text[start:end]
    first = len(unit) - len(unit.lstrip())
    cut = 0
    for m in _STOP.finditer(unit):
        after = unit[m.end():].lstrip()
        if not after or not _STARTS_SENTENCE.match(after):
            continue
        if m.group()[0] == "." and _is_abbreviation(unit, m.start(), first):
            continue
        _add(out, text, start + cut, start + m.end())
        cut = m.end()
    _add(out, text, start + cut, end)


def _is_abbreviation(unit: str, dot: int, first: int) -> bool:
    """Is the word ending at the period `unit[dot]` one that does not end a
    sentence? `first` is where the unit's text starts."""
    word_start = dot
    while word_start > 0 and not unit[word_start - 1].isspace():
        word_start -= 1
    word = unit[word_start:dot].lstrip("\"'“‘([")
    if not word:
        return False
    if word.lower() in ABBREVIATIONS:
        return True
    if len(word) == 1 and word.isalpha() and word.isupper():
        return True  # an initial
    if "." in word and all(len(part) <= 2 for part in word.split(".")):
        return True  # U.S, e.g, a.m
    return word.isdigit() and word_start == first  # a list number: "1. First"


def _add(out: list[tuple[int, int]], text: str, start: int, end: int) -> None:
    piece = text[start:end]
    stripped = piece.strip()
    if not stripped:
        return
    s = start + (len(piece) - len(piece.lstrip()))
    out.append((s, s + len(stripped)))
