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
