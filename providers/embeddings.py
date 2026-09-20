"""Embedding providers.

Phase 2 ships exactly one: a deterministic fake that needs no download and no
network, so the whole pipeline runs in the test suite. Real sentence-transformer
and API-backed providers are Phase 3 and slot in behind the same ABC.
"""

from __future__ import annotations

import hashlib
import math
import re
from abc import ABC, abstractmethod
from functools import lru_cache
from typing import Literal


class EmbeddingProvider(ABC):
    """One embedding model, as every stage that needs vectors sees it."""

    model_id: str
    revision: str
    vector_kind: Literal["dense", "sparse", "multi_vector"] = "dense"
    native_dim: int
    max_seq_len: int

    #: True only for models actually trained with nested representations.
    #: Truncating a non-matryoshka model's output is not dimensionality
    #: reduction, it is throwing away information, so it is refused.
    supports_matryoshka: bool = False

    def fingerprint(self) -> str:
        """Folded into the artifact hash of anything that embeds.

        A change of model or revision must miss the cache, or a stale index
        built with different vectors would be silently reused.
        """
        return f"{self.model_id}@{self.revision}"

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one L2-normalized `native_dim` vector per input text."""

    def embed_truncated(
        self, texts: list[str], dim: int | None
    ) -> list[list[float]]:
        """Matryoshka truncation: slice to `dim`, then L2-**renormalize**.

        The renormalization is the whole point. A slice of a unit vector is not
        unit length, and cosine similarity computed over non-unit vectors as if
        they were normalized is silently wrong — no exception, just worse
        retrieval. Truncation is one-directional: `dim` may never exceed
        `native_dim`.

        `dim=None` means "no truncation" and is always allowed.
        """
        if dim is None:
            return self.embed(texts)

        if not self.supports_matryoshka:
            raise ValueError(
                f"{self.model_id} was not trained with matryoshka nested "
                f"representations; truncating its output would discard "
                f"information rather than reduce dimensionality. Pass dim=None."
            )
        if dim <= 0:
            raise ValueError(f"dim must be positive, got {dim}")
        if dim > self.native_dim:
            raise ValueError(
                f"cannot truncate to {dim} dimensions: {self.model_id} is "
                f"{self.native_dim}-dimensional. Matryoshka only shrinks."
            )

        return [_l2_normalize(v[:dim]) for v in self.embed(texts)]


#: Word-ish tokens. Case-folded, punctuation dropped, so "Paris," and "paris"
#: land on the same dimension.
_TOKEN_RE = re.compile(r"[a-z0-9]+")


class FakeDeterministicEmbedder(EmbeddingProvider):
    """A hashed bag-of-words embedder. No model, no download, no network.

    It is a fake, but not a useless one: hashing the *whole* text to a vector
    would make every pair of texts equidistant, and every retrieval test built
    on it would pass vacuously. Instead each token is hashed to one dimension
    and accumulated, so texts that share words share coordinates. That gives the
    two properties retrieval tests actually depend on — reordered phrasings are
    near-identical, unrelated sentences are near-orthogonal — with none of the
    semantics a real model would add (synonyms stay unrelated).

    Each token expands to a *dense* pseudo-random vector rather than a single
    hashed coordinate. The sparse version is cheaper but breaks truncation: a
    slice of a handful of scattered coordinates is frequently all zeros, so
    `embed_truncated` would hand back an unnormalizable vector at small dims.
    Dense per-token vectors keep information spread over every prefix, which is
    what a real matryoshka model does too.

    Determinism is across processes, not just within one: `hashlib.sha256` is
    stable where the builtin `hash()` is salted per interpreter by PYTHONHASHSEED
    and would produce a different vector on every run.
    """

    model_id = "fake-deterministic"
    revision = "1"
    vector_kind: Literal["dense", "sparse", "multi_vector"] = "dense"
    native_dim = 384
    max_seq_len = 100000
    supports_matryoshka = True

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        dim = self.native_dim
        vec = [0.0] * dim
        for token in _TOKEN_RE.findall(text.lower()):
            token_vec = _token_vector(token, dim)
            for i in range(dim):
                vec[i] += token_vec[i]
        return _l2_normalize(vec)


@lru_cache(maxsize=1 << 16)
def _token_vector(token: str, dim: int) -> tuple[float, ...]:
    """One token's fixed random-looking unit-scale vector, floats in [-1, 1).

    Distinct tokens land near-orthogonal, so texts are similar exactly to the
    extent that they share words. Cached because a corpus reuses the same few
    thousand tokens tens of thousands of times.
    """
    needed = -(-dim // 32)  # sha256 gives 32 bytes at a time
    raw = b"".join(
        hashlib.sha256(f"{token}:{i}".encode("utf-8")).digest()
        for i in range(needed)
    )
    return tuple(byte / 127.5 - 1.0 for byte in raw[:dim])


def _l2_normalize(vec: list[float]) -> list[float]:
    """Scale to unit length; a zero vector is returned unchanged.

    Text with no tokens at all (the empty string, pure punctuation) has no
    coordinates to normalize. Returning zeros keeps it out of every result set,
    which is right, and avoids handing NaN to a vector store.
    """
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0.0:
        return vec
    return [x / norm for x in vec]


#: Name → provider class. Plugins name an embedder in their config as a plain
#: string, so this is the one place a name becomes an object.
_EMBEDDERS: dict[str, type[EmbeddingProvider]] = {
    FakeDeterministicEmbedder.model_id: FakeDeterministicEmbedder,
}


def get_embedder(name: str) -> EmbeddingProvider:
    """Return a ready-to-use provider by `model_id`."""
    try:
        return _EMBEDDERS[name]()
    except KeyError:
        raise KeyError(
            f"unknown embedder {name!r}. Available: {sorted(_EMBEDDERS)}"
        ) from None
