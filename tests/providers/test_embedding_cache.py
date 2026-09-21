"""The embedding cache: native width, keyed by kind, one pass per text."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from providers.embedding_cache import (
    DB_NAME,
    EmbeddingCache,
    cache_dir,
    cache_key,
    embed_cached,
)
from providers.embeddings import FakeDeterministicEmbedder

TEXTS = ["The capital of France is Paris.", "Bananas are yellow.", "Mitochondria."]


class Counting(FakeDeterministicEmbedder):
    """The fake, recording every text that actually reached the model."""

    name = "counting"
    model_id = "counting"

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str]] = []

    def _embed(self, texts, kind):
        self.calls.append((list(texts), kind))
        return super()._embed(texts, kind)


@pytest.fixture
def cache(tmp_path: Path) -> EmbeddingCache:
    return EmbeddingCache(tmp_path / "embcache")


def test_the_second_embed_is_a_hit(cache):
    p = Counting()
    first, s1 = embed_cached(p, TEXTS, cache=cache)
    second, s2 = embed_cached(p, TEXTS, cache=cache)

    assert (s1.computed, s1.cached) == (3, 0)
    assert (s2.computed, s2.cached) == (0, 3)
    assert len(p.calls) == 1
    assert first == second


def test_only_the_misses_are_embedded(cache):
    p = Counting()
    embed_cached(p, TEXTS[:2], cache=cache)
    _, stats = embed_cached(p, TEXTS, cache=cache)

    assert (stats.computed, stats.cached) == (1, 2)
    assert p.calls[-1][0] == [TEXTS[2]]


def test_duplicates_in_one_call_are_embedded_once(cache):
    p = Counting()
    vecs, stats = embed_cached(p, [TEXTS[0], TEXTS[0]], cache=cache)

    assert p.calls == [([TEXTS[0]], "document")]
    assert (stats.computed, stats.cached) == (1, 1)
    assert vecs[0] == vecs[1]


def test_the_cache_is_keyed_by_kind(cache):
    p = Counting()
    embed_cached(p, TEXTS, kind="document", cache=cache)
    _, stats = embed_cached(p, TEXTS, kind="query", cache=cache)

    assert (stats.computed, stats.cached) == (3, 0)
    assert [kind for _, kind in p.calls] == ["document", "query"]


def test_the_key_covers_model_revision_kind_and_text():
    base = cache_key("m", "r", "document", "t")
    assert len({
        base,
        cache_key("m2", "r", "document", "t"),
        cache_key("m", "r2", "document", "t"),
        cache_key("m", "r", "query", "t"),
        cache_key("m", "r", "document", "t2"),
    }) == 5


def test_vectors_are_stored_at_native_width(cache):
    p = Counting()
    embed_cached(p, TEXTS, dim=64, cache=cache)

    key = cache_key(p.model_id, p.revision, "document", TEXTS[0])
    stored = cache.get_many([key])[key]
    assert len(stored) == p.native_dim


@pytest.mark.parametrize("dim", [None, 256, 128, 64, 8])
def test_truncating_cached_vectors_equals_truncating_fresh_ones(cache, dim):
    p = Counting()
    embed_cached(p, TEXTS, cache=cache)  # warm, at native width
    cached, stats = embed_cached(p, TEXTS, dim=dim, cache=cache)

    assert stats.computed == 0
    assert cached == p.embed(TEXTS, dim=dim)
    for v in cached:
        assert len(v) == (dim or p.native_dim)
        assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, rel_tol=1e-9)


def test_a_dim_sweep_embeds_each_text_once(cache):
    p = Counting()
    totals = [embed_cached(p, TEXTS, dim=d, cache=cache)[1] for d in (None, 256, 128, 64)]

    assert sum(s.computed for s in totals) == len(TEXTS)
    assert len(p.calls) == 1


def test_a_bad_dim_fails_before_the_model_or_the_cache(cache):
    p = Counting()
    with pytest.raises(ValueError, match="384"):
        embed_cached(p, TEXTS, dim=1024, cache=cache)
    assert p.calls == []
    assert not cache.path.exists()


def test_no_texts_touches_nothing(cache):
    vecs, stats = embed_cached(Counting(), [], cache=cache)
    assert vecs == [] and (stats.computed, stats.cached) == (0, 0)
    assert not cache.path.exists()


def test_location_prefers_the_explicit_env_var(tmp_path, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_EMBED_CACHE", str(tmp_path / "x"))
    assert cache_dir() == tmp_path / "x"
    assert EmbeddingCache().path == tmp_path / "x" / DB_NAME


def test_location_falls_back_under_the_artifact_root(tmp_path, monkeypatch):
    """Under the artifact root, so `DELETE /api/cache` clears it too."""
    monkeypatch.delenv("RAG_PLAYGROUND_EMBED_CACHE", raising=False)
    monkeypatch.setenv("RAG_PLAYGROUND_ARTIFACTS", str(tmp_path / "arts"))
    assert cache_dir() == tmp_path / "arts" / ".embcache"


def test_the_default_cache_follows_the_env_var(tmp_path, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_EMBED_CACHE", str(tmp_path / "envcache"))
    embed_cached(Counting(), TEXTS)
    assert (tmp_path / "envcache" / DB_NAME).is_file()
