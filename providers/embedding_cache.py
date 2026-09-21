"""A persistent embedding cache, so a vector is computed once per text per model.

Vectors are stored at **native** width, keyed by
`sha256(model_id | revision | dtype | kind | text)`, and truncated on the way out. That
is what makes a Matryoshka sweep cheap: indexing at 1024, 512, 256, 128 and 64
dimensions runs the model over each chunk once, and the other four builds are
slices of the cached vectors.

`kind` is part of the key because a query and a document embedding of the same
string are different vectors for any instruction-aware model.

Location: `$RAG_PLAYGROUND_EMBED_CACHE`, else
`<$RAG_PLAYGROUND_ARTIFACTS or <repo>/artifacts>/.embcache/`. Living under the
artifact root means `DELETE /api/cache` clears it along with everything else.

Every provider goes through here, the fake included. The fake is cheap enough
not to need it, but routing it the same way means the fast suite exercises the
exact code path the real models use.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
from array import array
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from providers.embeddings import EmbedKind, EmbeddingProvider, truncate

REPO_ROOT = Path(__file__).resolve().parents[1]
DB_NAME = "embeddings.sqlite"

#: SQLite's bound-parameter limit is 32766 on current builds but 999 on old
#: ones; batching well under both keeps lookups portable.
_BATCH = 500


def cache_dir() -> Path:
    explicit = os.environ.get("RAG_PLAYGROUND_EMBED_CACHE")
    if explicit:
        return Path(explicit)
    artifacts = os.environ.get("RAG_PLAYGROUND_ARTIFACTS") or REPO_ROOT / "artifacts"
    return Path(artifacts) / ".embcache"


def cache_key(model_id: str, revision: str, kind: str, text: str, dtype: str = "") -> str:
    """`dtype` is part of the key: one checkpoint in two dtypes is two models.

    It is omitted from the hashed string when empty, so keys for providers with
    no dtype (the fake) are unchanged.
    """
    identity = f"{model_id}|{revision}|{dtype}" if dtype else f"{model_id}|{revision}"
    return hashlib.sha256(f"{identity}|{kind}|{text}".encode("utf-8")).hexdigest()


@dataclass
class EmbedStats:
    #: Texts actually run through the model.
    computed: int = 0
    #: Texts served from the cache (or duplicates of a text in the same call).
    cached: int = 0


class EmbeddingCache:
    """SQLite, one row per vector, float64 so a cached vector equals a fresh one.

    A connection is opened per operation and closed straight after: an open
    handle on Windows would make `DELETE /api/cache` fail to remove the file.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = Path(directory) if directory is not None else cache_dir()
        self.path = self.directory / DB_NAME

    def _connect(self) -> sqlite3.Connection:
        self.directory.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=30)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS vectors "
            "(key TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL)"
        )
        return conn

    def get_many(self, keys: list[str]) -> dict[str, list[float]]:
        if not keys:
            return {}
        found: dict[str, list[float]] = {}
        with closing(self._connect()) as conn:
            for start in range(0, len(keys), _BATCH):
                batch = keys[start : start + _BATCH]
                marks = ",".join("?" * len(batch))
                for key, blob in conn.execute(
                    f"SELECT key, vec FROM vectors WHERE key IN ({marks})", batch
                ):
                    found[key] = array("d", blob).tolist()
        return found

    def put_many(self, items: dict[str, list[float]]) -> None:
        if not items:
            return
        with closing(self._connect()) as conn:
            with conn:
                conn.executemany(
                    "INSERT OR REPLACE INTO vectors (key, dim, vec) VALUES (?, ?, ?)",
                    [
                        (key, len(vec), array("d", vec).tobytes())
                        for key, vec in items.items()
                    ],
                )


def embed_cached(
    provider: EmbeddingProvider,
    texts: list[str],
    *,
    kind: EmbedKind = "document",
    dim: int | None = None,
    cache: EmbeddingCache | None = None,
) -> tuple[list[list[float]], EmbedStats]:
    """`provider.embed(texts, kind=kind, dim=dim)`, through the cache.

    Misses are embedded at native width in one batch and stored; every vector
    is then truncated to `dim`. `dim` is validated first, so a bad truncation
    fails before any model is loaded.
    """
    provider.check_dim(dim)
    if not texts:
        return [], EmbedStats()
    cache = cache or EmbeddingCache()

    keys = [
        cache_key(provider.model_id, provider.revision, kind, t, provider.dtype)
        for t in texts
    ]
    found = cache.get_many(list(dict.fromkeys(keys)))

    missing: dict[str, str] = {}
    for key, text in zip(keys, texts):
        if key not in found:
            missing.setdefault(key, text)

    if missing:
        fresh = provider.embed(list(missing.values()), kind=kind)
        new = dict(zip(missing, fresh))
        cache.put_many(new)
        found.update(new)

    stats = EmbedStats(computed=len(missing), cached=len(texts) - len(missing))
    return truncate([found[key] for key in keys], dim), stats
