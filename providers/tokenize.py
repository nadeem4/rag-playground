"""Token counting.

Chunkers need a token budget, and the whole point of a chunking bench is that
you can compare chunkers without first downloading a tokenizer. Phase 2 ships a
regex heuristic; real BPE tokenizers arrive in Phase 3 behind this protocol.
"""

from __future__ import annotations

import re
from typing import Protocol, runtime_checkable


@runtime_checkable
class TokenCounter(Protocol):
    """Anything that can say how many tokens a string costs."""

    def count(self, text: str) -> int: ...


#: Word runs and single punctuation marks, which is roughly how a BPE
#: tokenizer segments plain prose. Whitespace is a separator, never a token.
_TOKEN_RE = re.compile(r"\w+|[^\w\s]")


class HeuristicTokenCounter:
    """Word/punct split. No network, no vocabulary file, deterministic.

    It undercounts against a real BPE tokenizer on rare words, which is fine:
    chunkers need a *stable, comparable* budget, and being off by a constant
    factor changes chunk size, not correctness.
    """

    def count(self, text: str) -> int:
        return len(_TOKEN_RE.findall(text))
