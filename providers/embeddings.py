"""Embedding providers.

Three are registered: two real sentence-transformer models and a deterministic
fake that needs no download and no network, so the whole pipeline runs in the
fast test suite.

| name                   | model                       | native_dim | Matryoshka |
|------------------------|-----------------------------|------------|------------|
| `qwen3-embedding-0.6b` | `Qwen/Qwen3-Embedding-0.6B` | 1024       | yes        |
| `bge-small-en-v1.5`    | `BAAI/bge-small-en-v1.5`    | 384        | no         |
| `fake-deterministic`   | hashed bag of words         | 384        | yes        |

**Importing this module never imports torch or sentence-transformers.** A real
model is loaded on its first `embed()` call and kept for the life of the
process. Everything that only needs a provider's *identity* (the index
fingerprint, the registry, the config schema) therefore stays instant.

Every provider shares one public call, `embed(texts, *, kind, dim)`:

- `kind="query"` applies the model's query instruction; `kind="document"`
  applies none. Asymmetric models are trained this way, and embedding a
  question with no instruction measurably hurts retrieval.
- `dim` is Matryoshka truncation: slice, then L2-renormalize.
"""

from __future__ import annotations

import hashlib
import math
import re
import threading
from abc import ABC, abstractmethod
from functools import lru_cache
from typing import Any, Literal, get_args

EmbedKind = Literal["document", "query"]

#: The registered embedder names, as a type. Plugin configs use this directly so
#: the form renderer offers a dropdown and a typo fails config validation.
#: `test_embedder_name_literal_matches_the_registry` keeps it honest.
EmbedderName = Literal["qwen3-embedding-0.6b", "bge-small-en-v1.5", "fake-deterministic"]


class EmbeddingProvider(ABC):
    """One embedding model, as every stage that needs vectors sees it."""

    #: The registry key: what a config names and what the index descriptor
    #: records as `embedding_model`.
    name: str
    #: The upstream model id, e.g. the Hugging Face repo.
    model_id: str
    #: Pinned upstream revision (a commit sha for real models).
    revision: str
    vector_kind: Literal["dense", "sparse", "multi_vector"] = "dense"
    native_dim: int
    max_seq_len: int

    #: True only for models actually trained with nested representations.
    #: Truncating a non-matryoshka model's output is not dimensionality
    #: reduction, it is throwing away information, so it is refused.
    supports_matryoshka: bool = False

    #: The numeric dtype the model is loaded in, or "" for providers that have
    #: none. float32 and bfloat16 give different vectors from one checkpoint,
    #: so this is part of the model's identity, not a performance detail. It
    #: is the single source for the loader, the fingerprint and the cache key.
    dtype: str = ""

    def fingerprint(self) -> str:
        """Folded into the artifact hash of anything that embeds.

        A change of model, revision or dtype must miss the cache, or a stale
        index built with different vectors would be silently reused.
        """
        base = f"{self.model_id}@{self.revision}"
        return f"{base}#{self.dtype}" if self.dtype else base

    def embed(
        self,
        texts: list[str],
        *,
        kind: EmbedKind = "document",
        dim: int | None = None,
    ) -> list[list[float]]:
        """One L2-normalized vector per text, `dim` wide (native if `None`)."""
        self.check_dim(dim)
        if not texts:
            return []
        return truncate(self._embed(list(texts), kind), dim)

    @abstractmethod
    def _embed(self, texts: list[str], kind: EmbedKind) -> list[list[float]]:
        """Native-width, L2-normalized vectors for a non-empty list."""

    def check_dim(self, dim: int | None) -> None:
        """Refuse a truncation this model cannot honour, with a readable reason.

        `dim=None` means "no truncation" and is always allowed. Truncation is
        one-directional: `dim` may never exceed `native_dim`.
        """
        if dim is None:
            return
        if not self.supports_matryoshka:
            raise ValueError(
                f"embedder '{self.name}' was not trained with matryoshka nested "
                f"representations, so truncate_dim cannot be set on it; "
                f"truncating its output would discard information rather than "
                f"reduce dimensionality. Leave truncate_dim empty, or pick a "
                f"matryoshka embedder."
            )
        if dim <= 0:
            raise ValueError(f"truncate_dim must be positive, got {dim}")
        if dim > self.native_dim:
            raise ValueError(
                f"cannot truncate to {dim} dimensions: embedder '{self.name}' is "
                f"{self.native_dim}-dimensional. Matryoshka only shrinks; pick "
                f"a truncate_dim of at most {self.native_dim}."
            )


def truncate(vectors: list[list[float]], dim: int | None) -> list[list[float]]:
    """Matryoshka truncation: slice to `dim`, then L2-**renormalize**.

    The renormalization is the whole point. A slice of a unit vector is not
    unit length, and cosine similarity computed over non-unit vectors as if they
    were normalized is silently wrong: no exception, just worse retrieval.
    Callers validate `dim` against the provider first (`check_dim`).
    """
    if dim is None:
        return vectors
    return [_l2_normalize(list(v[:dim])) for v in vectors]


#: Word-ish tokens. Case-folded, punctuation dropped, so "Paris," and "paris"
#: land on the same dimension.
_TOKEN_RE = re.compile(r"[a-z0-9]+")


class FakeDeterministicEmbedder(EmbeddingProvider):
    """A hashed bag-of-words embedder. No model, no download, no network.

    It is a fake, but not a useless one: hashing the *whole* text to a vector
    would make every pair of texts equidistant, and every retrieval test built
    on it would pass vacuously. Instead each token is hashed to one dimension
    and accumulated, so texts that share words share coordinates. That gives the
    two properties retrieval tests actually depend on (reordered phrasings are
    near-identical, unrelated sentences are near-orthogonal) with none of the
    semantics a real model would add (synonyms stay unrelated).

    Each token expands to a *dense* pseudo-random vector rather than a single
    hashed coordinate. The sparse version is cheaper but breaks truncation: a
    slice of a handful of scattered coordinates is frequently all zeros, so
    truncation would hand back an unnormalizable vector at small dims. Dense
    per-token vectors keep information spread over every prefix, which is what a
    real matryoshka model does too.

    Determinism is across processes, not just within one: `hashlib.sha256` is
    stable where the builtin `hash()` is salted per interpreter by PYTHONHASHSEED
    and would produce a different vector on every run.

    `kind` is ignored: the fake has no query instruction.
    """

    name = "fake-deterministic"
    model_id = "fake-deterministic"
    revision = "1"
    vector_kind: Literal["dense", "sparse", "multi_vector"] = "dense"
    native_dim = 384
    max_seq_len = 100000
    supports_matryoshka = True

    def _embed(self, texts: list[str], kind: EmbedKind) -> list[list[float]]:
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


# --------------------------------------------------------------------------
# real models
# --------------------------------------------------------------------------


class SentenceTransformerEmbedder(EmbeddingProvider):
    """A Hugging Face model run locally through sentence-transformers, on CPU.

    The revision is a commit sha, never a branch: `main` moves, and a model that
    changes under a cached index serves vectors from two different spaces.
    """

    #: Named prompt from the model's own `config_sentence_transformers.json`,
    #: applied for `kind="query"`. Takes precedence over `query_prefix`.
    query_prompt_name: str | None = None
    #: Literal instruction prefix for `kind="query"`, for models that ship none.
    query_prefix: str | None = None
    batch_size: int = 16
    #: Explicit float32. transformers 5 otherwise loads a checkpoint in its
    #: stored dtype, which for Qwen3 is bfloat16, and bf16 matmuls on a CPU
    #: without native support ran about 7x slower (7.6 s per chunk against
    #: 1.1 s, measured). Changing this changes the fingerprint and cache keys.
    dtype: str = "float32"

    def _embed(self, texts: list[str], kind: EmbedKind) -> list[list[float]]:
        prompt_kwargs: dict[str, Any] = {}
        if kind == "query":
            if self.query_prompt_name is not None:
                prompt_kwargs["prompt_name"] = self.query_prompt_name
            elif self.query_prefix is not None:
                prompt_kwargs["prompt"] = self.query_prefix

        model = _load_model(self.model_id, self.revision, self.dtype)
        vectors = model.encode(
            texts,
            batch_size=self.batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
            **prompt_kwargs,
        )
        return vectors.astype("float64").tolist()


class Qwen3Embedding06B(SentenceTransformerEmbedder):
    """The default: 1024 dims, Matryoshka-trained, instruction-aware.

    Its query instruction ships in the model's own sentence-transformers config
    as the `query` prompt; documents take none.
    """

    name = "qwen3-embedding-0.6b"
    model_id = "Qwen/Qwen3-Embedding-0.6B"
    revision = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
    native_dim = 1024
    max_seq_len = 32768
    supports_matryoshka = True
    query_prompt_name = "query"


class BgeSmallEnV15(SentenceTransformerEmbedder):
    """The labelled 2024 baseline: small, fast, and not Matryoshka-trained."""

    name = "bge-small-en-v1.5"
    model_id = "BAAI/bge-small-en-v1.5"
    revision = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
    native_dim = 384
    max_seq_len = 512
    supports_matryoshka = False
    query_prefix = "Represent this sentence for searching relevant passages: "


_LOAD_LOCK = threading.Lock()
_MODELS: dict[tuple[str, str, str], Any] = {}


def _load_model(model_id: str, revision: str, dtype: str) -> Any:
    """Load a model once per process; the import happens here, not at module top.

    The lock matters: the executor may run nodes concurrently, and two threads
    racing a first load would each pull a 1 GB model into memory. `dtype` is
    part of the key because one checkpoint in two dtypes is two models.
    """
    key = (model_id, revision, dtype)
    with _LOAD_LOCK:
        if key not in _MODELS:
            import torch
            from sentence_transformers import SentenceTransformer

            _MODELS[key] = SentenceTransformer(
                model_id,
                revision=revision,
                device="cpu",
                model_kwargs={"dtype": getattr(torch, dtype)},
            )
        return _MODELS[key]


#: Name -> provider class. Plugins name an embedder in their config as a plain
#: string, so this is the one place a name becomes an object.
_EMBEDDERS: dict[str, type[EmbeddingProvider]] = {
    cls.name: cls
    for cls in (Qwen3Embedding06B, BgeSmallEnV15, FakeDeterministicEmbedder)
}

EMBEDDER_NAMES: tuple[str, ...] = get_args(EmbedderName)


def get_embedder(name: str) -> EmbeddingProvider:
    """Return a ready-to-use provider by registry name. Never loads a model."""
    try:
        return _EMBEDDERS[name]()
    except KeyError:
        raise KeyError(
            f"unknown embedder {name!r}. Available: {sorted(_EMBEDDERS)}"
        ) from None
