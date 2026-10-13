"""letter_counts: a tiny embedder that needs no download.

An embedder is not a stage strategy: it is an Embedder subclass, and
`embed: {use: letter_counts}` picks it for any store that has an `embedder`
setting. It turns each text into a vector of 26 numbers, how often each letter
appears. That matches spelling, not meaning, so it is only for trying things.
"""

import math

from pandion.extend import Embedder, register


@register
class LetterCounts(Embedder):
    name = "letter_counts"               # the name you write under embed: use:
    model_id = "example/letter-counts"   # what model this is
    revision = "1"                       # change it when the vectors change, so old ones are not reused
    native_dim = 26                      # how many numbers each vector has
    max_seq_len = 100_000                # the longest text it takes

    # Return one vector per text, each of length 1 (a unit vector), so that a
    # dot product of two vectors is their cosine similarity.
    def _embed(self, texts, kind):
        return [_unit(_counts(text)) for text in texts]


def _counts(text):
    counts = [0.0] * 26
    for letter in text.lower():
        if "a" <= letter <= "z":
            counts[ord(letter) - ord("a")] += 1
    return counts


def _unit(vector):
    length = math.sqrt(sum(x * x for x in vector))
    if length == 0:
        # A text with no letters still needs a unit vector.
        return [1 / math.sqrt(len(vector))] * len(vector)
    return [x / length for x in vector]
