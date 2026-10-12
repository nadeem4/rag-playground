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
    return " ".join(
        word
        for word in normalise(text).split(" ")
        if not (_MARKER.match(word) or (len(word) == 1 and word.isalpha()))
    )
