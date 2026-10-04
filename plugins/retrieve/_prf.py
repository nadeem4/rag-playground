"""Pseudo-relevance feedback: pick the words to add to a keyword search.

A question in the reader's own words can share no word at all with the
document ("current employer" against a resume that says "Present"), so a
keyword search matches nothing. PRF assumes the top few dense hits are about
the right thing and borrows their most distinctive words: frequent in those
hits (tf), rare across the whole chunk set (idf). The words the question
already has are skipped, since the keyword search has them already.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Iterable

#: Common English words that carry no topic. Kept inline and short on purpose:
#: the idf weight already pushes down words that are common in this document.
STOPWORDS = frozenset(
    """
    about above after again against all also and any are aren because been
    before being below between both but can cannot could did does doing down
    during each few for from further had has have having her here hers herself
    him himself his how into its itself just more most myself nor not now off
    once only other our ours ourselves out over own same she should since some
    such than that the their theirs them themselves then there these they this
    those through too under until very was were what when where which while who
    whom why will with would you your yours yourself yourselves were way may
    might must shall upon via etc per within without across along among around
    get got use used using like well many much one two three new yet ever even
    """.split()
)

_WORD = re.compile(r"[a-z]+")


def tokens(text: str) -> list[str]:
    """Lowercase words of three letters or more; digits and punctuation split."""
    return [t for t in _WORD.findall(text.lower()) if len(t) >= 3]


def select_terms(
    top_texts: Iterable[str], all_texts: Iterable[str], question: str, n: int
) -> list[str]:
    """The `n` best expansion terms from `top_texts`, best first.

    Score is the term's count across the top texts times a smoothed idf over
    `all_texts` (the chunk set the index was built from). Ties go to the
    alphabetically first term, so the choice is deterministic.
    """
    skip = STOPWORDS | set(tokens(question))
    tf = Counter(t for text in top_texts for t in tokens(text) if t not in skip)
    if not tf or n < 1:
        return []

    documents = [set(tokens(text)) for text in all_texts]
    total = len(documents)

    def idf(term: str) -> float:
        df = sum(1 for doc in documents if term in doc)
        return math.log((total + 1) / (df + 1)) + 1.0

    scored = sorted(tf, key=lambda term: (-tf[term] * idf(term), term))
    return scored[:n]
