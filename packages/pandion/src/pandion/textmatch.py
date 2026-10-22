"""The one rule for "is this passage the same text?", shared by the question
check, the eval step and the miss trace.

Parsers disagree about a handful of things that are not the words: spacing and
line breaks, a word hyphenated across a line, capital letters, straight against
curly quotes, and typographic ligatures (the single "fi" glyph some PDFs hold).
`normalise` removes exactly those differences and nothing else, so a passage
that still differs after it is really different text.

`normalise_with_offsets` also says, for every character it returns, which
character of the input it came from, so a match found in the normalised text
can be shown back in the document's own wording.
"""

from __future__ import annotations

import re

#: Curly and typographic quotes fold to the straight ones.
QUOTES = {
    "‘": "'", "’": "'", "‚": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "″": '"',
}

#: Typographic ligatures expand to their letters.
LIGATURES = {
    "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
}


def normalise_with_offsets(text: str) -> tuple[str, list[int]]:
    """The normalised text, and for each of its characters the index it came from."""
    out: list[str] = []
    index: list[int] = []
    i, n = 0, len(text)
    while i < n:
        char = text[i]
        if char == "-":
            j = i + 1
            while j < n and text[j] in " \t":
                j += 1
            if j < n and text[j] in "\r\n":  # a word broken across a line
                while j < n and text[j].isspace():
                    j += 1
                i = j
                continue
        if char.isspace():
            if out and out[-1] != " ":
                out.append(" ")
                index.append(i)
            i += 1
            continue
        folded = LIGATURES.get(char) or QUOTES.get(char, char)
        for piece in folded.casefold():
            out.append(piece)
            index.append(i)
        i += 1
    while out and out[-1] == " ":
        out.pop()
        index.pop()
    return "".join(out), index


def normalise(text: str) -> str:
    """The same passage as a parser with other habits would have written it."""
    return normalise_with_offsets(text)[0]


#: A list marker standing alone: a bullet, or a number, letter or roman numeral
#: followed by "." or ")", or held in brackets: "1.", "b)", "(3)", "iv.", "-".
_MARKER = re.compile(r"^(?:[-•*–·▪‣◦]|\(?(?:\d{1,3}|[a-z]|[ivx]{1,4})[.)])$")


def loosen(text: str) -> str:
    """The normalised text with list markers and lone letters set aside.

    The third and loosest tier, "reworded". A parser can rewrite a numbered list
    as bullets ("1. $2,000; or" becomes "- $2,000; or"), and a vertical watermark
    can drop single letters into a sentence ("D If an insured person dies"). Both
    are layout, not words of the answer. Set aside on both sides of a comparison,
    they cannot make different words match: every other word and number stays.
    """
    return _loosen_normalised(normalise(text))


def _loosen_normalised(normalised: str) -> str:
    """`loosen` for text `normalise` already made."""
    return " ".join(
        word
        for word in normalised.split(" ")
        if not (_MARKER.match(word) or (len(word) == 1 and word.isalpha()))
    )


class Text:
    """A text, a piece or a gold passage, with its two looser forms made once, when first needed."""

    def __init__(self, text: str) -> None:
        self.text = text
        self._normalised: str | None = None
        self._loosened: str | None = None

    @property
    def normalised(self) -> str:
        if self._normalised is None:
            self._normalised = normalise(self.text)
        return self._normalised

    @property
    def loosened(self) -> str:
        if self._loosened is None:
            self._loosened = _loosen_normalised(self.normalised)
        return self._loosened


def match(gold: str | Text, text: str | Text) -> str | None:
    """How `text` holds the passage `gold`: "exact", "normalized" or
    "reworded", the strictest that holds, or None when it does not. Pass
    `Text`s to reuse their looser forms across many comparisons."""
    gold = gold if isinstance(gold, Text) else Text(gold)
    text = text if isinstance(text, Text) else Text(text)
    if gold.text in text.text:
        return "exact"
    if gold.normalised in text.normalised:
        return "normalized"
    if gold.loosened and gold.loosened in text.loosened:
        return "reworded"
    return None


def first_matches(golds: list[str], texts: list[str]) -> list[tuple[int, str] | None]:
    """For each gold passage, the place in `texts` of the first text that
    holds it and how (`match`), or None when none does. Stops reading once
    every passage is placed. Each passage and each text is normalised once."""
    passages = [Text(gold) for gold in golds]
    found: list[tuple[int, str] | None] = [None] * len(golds)
    left = set(range(len(golds)))
    for i, raw in enumerate(texts):
        if not left:
            break
        text = Text(raw)
        for n in sorted(left):
            kind = match(passages[n], text)
            if kind is not None:
                found[n] = (i, kind)
                left.discard(n)
    return found
