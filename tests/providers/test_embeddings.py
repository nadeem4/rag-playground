import math
import os
import subprocess
import sys
from pathlib import Path

import pytest

from providers.embeddings import (
    EmbeddingProvider,
    FakeDeterministicEmbedder,
    get_embedder,
)


ROOT = Path(__file__).resolve().parents[2]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


@pytest.fixture
def embedder() -> FakeDeterministicEmbedder:
    return FakeDeterministicEmbedder()


# --- declared capabilities -------------------------------------------------


def test_declared_capabilities(embedder):
    assert embedder.model_id == "fake-deterministic"
    assert embedder.revision == "1"
    assert embedder.native_dim == 384
    assert embedder.max_seq_len == 100000
    assert embedder.supports_matryoshka is True
    assert embedder.vector_kind == "dense"
    assert isinstance(embedder, EmbeddingProvider)


def test_fingerprint_is_model_at_revision(embedder):
    assert embedder.fingerprint() == "fake-deterministic@1"


def test_fingerprint_changes_with_model_and_revision(embedder):
    """The fingerprint feeds the artifact hash: a different model or a
    different revision must never collide with the old cache entry."""

    class Bumped(FakeDeterministicEmbedder):
        revision = "2"

    class Renamed(FakeDeterministicEmbedder):
        model_id = "other-fake"

    assert Bumped().fingerprint() == "fake-deterministic@2"
    assert Renamed().fingerprint() == "other-fake@1"
    assert len({embedder.fingerprint(), Bumped().fingerprint(), Renamed().fingerprint()}) == 3


# --- shape and normalization ----------------------------------------------


def test_embed_returns_one_unit_vector_of_native_dim_per_text(embedder):
    vecs = embedder.embed(["the capital of France", "python syntax", "a b c"])
    assert len(vecs) == 3
    for v in vecs:
        assert len(v) == 384
        assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, rel_tol=1e-9)


def test_embed_of_empty_list_is_empty(embedder):
    assert embedder.embed([]) == []


def test_empty_string_does_not_raise_or_produce_nan(embedder):
    (v,) = embedder.embed([""])
    assert len(v) == 384
    assert not any(math.isnan(x) for x in v)
    assert all(x == 0.0 for x in v)


def test_whitespace_and_punctuation_only_text_is_safe(embedder):
    for text in ["   ", "!!! ???", "\n\t"]:
        (v,) = embedder.embed([text])
        assert not any(math.isnan(x) for x in v)


# --- determinism -----------------------------------------------------------


def test_same_text_gives_identical_vector(embedder):
    a = embedder.embed(["Paris is the capital of France"])[0]
    b = FakeDeterministicEmbedder().embed(["Paris is the capital of France"])[0]
    assert a == b


def test_golden_vector_is_exact():
    """Pinned against an independently derived value.

    If this ever drifts, every cached index built by an earlier run is silently
    invalid. Bump `revision` deliberately instead of editing this number.
    """
    (v,) = FakeDeterministicEmbedder().embed(["hello world"])
    assert v[:5] == pytest.approx(
        [
            -0.020584427656644335,
            0.09289382737357443,
            -0.0015834175120495585,
            0.015306369283145785,
            -0.0163619809578455,
        ],
        abs=1e-15,
    )


def test_deterministic_across_processes():
    """builtin hash() is salted per process; this proves we do not use it.

    Run twice with opposing PYTHONHASHSEED settings — a salted hash would move.
    """
    script = (
        "from providers.embeddings import FakeDeterministicEmbedder;"
        "print(FakeDeterministicEmbedder().embed(['Paris is the capital of France'])[0][:8])"
    )
    outs = []
    for seed in ("random", "0"):
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=True,
            cwd=ROOT,
            env=os.environ | {"PYTHONHASHSEED": seed},
        )
        outs.append(proc.stdout.strip())
    assert outs[0] == outs[1]
    assert outs[0] == str(
        FakeDeterministicEmbedder().embed(["Paris is the capital of France"])[0][:8]
    )


# --- semantics: similar text must be meaningfully close --------------------


def test_reordered_sentence_is_highly_similar(embedder):
    a, b = embedder.embed(
        ["The capital of France is Paris", "Paris is the capital of France"]
    )
    assert cosine(a, b) > 0.8


def test_unrelated_sentence_is_far(embedder):
    a, b = embedder.embed(
        ["The capital of France is Paris", "Python list comprehension syntax"]
    )
    assert cosine(a, b) < 0.3


def test_word_order_does_not_matter(embedder):
    """Bag of words: a shuffle of the same words is the same vector."""
    a, b = embedder.embed(["alpha beta gamma delta", "delta gamma beta alpha"])
    assert cosine(a, b) > 0.999


def test_partial_overlap_sits_between_the_two_extremes(embedder):
    base, overlapping, unrelated = embedder.embed(
        [
            "the capital of France is Paris",
            "the capital of Germany is Berlin",
            "Python list comprehension syntax",
        ]
    )
    assert cosine(base, unrelated) < cosine(base, overlapping) < 1.0


def test_case_and_punctuation_are_ignored(embedder):
    a, b = embedder.embed(["Paris, France!", "paris france"])
    assert cosine(a, b) > 0.999


# --- matryoshka truncation -------------------------------------------------


@pytest.mark.parametrize("dim", [8, 32, 64, 128, 256, 384])
def test_truncated_vectors_are_unit_length(embedder, dim):
    """Slicing a unit vector yields a shorter, non-unit vector. Skipping the
    renormalization silently corrupts every cosine score downstream."""
    for v in embedder.embed(["the capital of France is Paris"] * 2, dim=dim):
        assert len(v) == dim
        assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, rel_tol=1e-9)


def test_truncation_renormalizes_rather_than_slicing_raw(embedder):
    text = "the capital of France is Paris and it is lovely in spring"
    (full,) = embedder.embed([text])
    (short,) = embedder.embed([text], dim=64)
    raw = full[:64]
    raw_norm = math.sqrt(sum(x * x for x in raw))
    assert raw_norm < 1.0  # the slice really is not unit length
    assert short == pytest.approx([x / raw_norm for x in raw])


def test_truncate_to_none_returns_native_vectors(embedder):
    text = "the capital of France is Paris"
    assert embedder.embed([text], dim=None) == embedder.embed([text])


def test_truncation_is_one_directional(embedder):
    """Matryoshka only shrinks. Asking for more than native must fail loudly
    rather than zero-pad into a wrong-shaped index."""
    with pytest.raises(ValueError, match="384"):
        embedder.embed(["x"], dim=385)
    with pytest.raises(ValueError, match="384"):
        embedder.embed(["x"], dim=1024)


@pytest.mark.parametrize("dim", [0, -1])
def test_non_positive_dim_raises(embedder, dim):
    with pytest.raises(ValueError):
        embedder.embed(["x"], dim=dim)


def test_provider_without_matryoshka_refuses_truncation():
    class NoMatryoshka(FakeDeterministicEmbedder):
        name = "no-matryoshka"
        model_id = "no-matryoshka"
        supports_matryoshka = False

    p = NoMatryoshka()
    with pytest.raises(ValueError, match="matryoshka"):
        p.embed(["x"], dim=64)
    # None is still fine: it means "no truncation".
    assert len(p.embed(["x"], dim=None)[0]) == 384


def test_truncated_vectors_preserve_relative_similarity(embedder):
    a, b = embedder.embed(
        ["The capital of France is Paris", "Paris is the capital of France"], dim=256
    )
    assert cosine(a, b) > 0.8


# --- registry --------------------------------------------------------------


def test_get_embedder_returns_the_fake_by_name():
    p = get_embedder("fake-deterministic")
    assert isinstance(p, FakeDeterministicEmbedder)


def test_get_embedder_is_usable_without_further_setup():
    assert len(get_embedder("fake-deterministic").embed(["hi"])[0]) == 384


def test_get_embedder_rejects_unknown_name_and_lists_options():
    with pytest.raises(KeyError, match="fake-deterministic"):
        get_embedder("text-embedding-3-large")


# --- kind: the query instruction -------------------------------------------


def test_the_fake_ignores_kind(embedder):
    text = "What is the capital of France?"
    assert embedder.embed([text], kind="query") == embedder.embed([text], kind="document")


def test_kind_defaults_to_document():
    seen: list[str] = []

    class Recorder(FakeDeterministicEmbedder):
        def _embed(self, texts, kind):
            seen.append(kind)
            return super()._embed(texts, kind)

    Recorder().embed(["x"])
    Recorder().embed(["x"], kind="query")
    assert seen == ["document", "query"]


def test_empty_input_never_reaches_the_model():
    class Exploding(FakeDeterministicEmbedder):
        def _embed(self, texts, kind):
            raise AssertionError("model called for no texts")

    assert Exploding().embed([], kind="query", dim=64) == []


# --- the real models, as declared (no model is loaded here) ---------------


def test_embedder_name_literal_matches_the_registry():
    from typing import get_args

    from providers.embeddings import _EMBEDDERS, EmbedderName

    assert set(get_args(EmbedderName)) == set(_EMBEDDERS)
    for name, cls in _EMBEDDERS.items():
        assert cls.name == name


def test_registered_real_embedders_match_the_plan():
    qwen = get_embedder("qwen3-embedding-0.6b")
    bge = get_embedder("bge-small-en-v1.5")

    assert (qwen.model_id, qwen.native_dim, qwen.supports_matryoshka) == (
        "Qwen/Qwen3-Embedding-0.6B",
        1024,
        True,
    )
    assert (bge.model_id, bge.native_dim, bge.supports_matryoshka) == (
        "BAAI/bge-small-en-v1.5",
        384,
        False,
    )


@pytest.mark.parametrize("name", ["qwen3-embedding-0.6b", "bge-small-en-v1.5"])
def test_real_embedders_pin_a_commit_sha(name):
    """`main` moves; a cached index must never straddle two model versions."""
    p = get_embedder(name)
    assert len(p.revision) == 40 and all(c in "0123456789abcdef" for c in p.revision)
    assert p.fingerprint() == f"{p.model_id}@{p.revision}#{p.dtype}"


@pytest.mark.parametrize("name", ["qwen3-embedding-0.6b", "bge-small-en-v1.5"])
def test_numeric_dtype_is_part_of_model_identity(name):
    """float32 and bfloat16 give different vectors from the same checkpoint.

    If the load dtype were not part of the fingerprint and the cache key, a
    change of dtype would silently reuse vectors computed in the old one. Pure:
    neither call loads a model.
    """
    from providers.embedding_cache import cache_key

    p = get_embedder(name)
    assert p.dtype == "float32"

    Bf16 = type("Bf16", (type(p),), {"dtype": "bfloat16"})
    assert Bf16().fingerprint() != p.fingerprint()
    assert cache_key(p.model_id, p.revision, "document", "t", p.dtype) != cache_key(
        p.model_id, p.revision, "document", "t", "bfloat16"
    )


def test_fake_embedder_identity_is_unchanged_by_the_dtype_field():
    """The fake has no dtype, so its fingerprint and cache keys stay as they were."""
    from providers.embedding_cache import cache_key

    fake = get_embedder("fake-deterministic")
    assert fake.dtype == ""
    assert fake.fingerprint() == f"{fake.model_id}@{fake.revision}"
    assert cache_key("m", "r", "document", "t", "") == cache_key("m", "r", "document", "t")


def test_query_instructions_are_wired_per_model():
    from providers.embeddings import BgeSmallEnV15, Qwen3Embedding06B

    assert Qwen3Embedding06B.query_prompt_name == "query"
    assert BgeSmallEnV15.query_prefix == (
        "Represent this sentence for searching relevant passages: "
    )


class _FakeModel:
    """Stands in for a SentenceTransformer and records how it was called."""

    def __init__(self, dim: int):
        self.dim = dim
        self.calls: list[dict] = []

    def encode(self, texts, **kwargs):
        import numpy as np

        self.calls.append({"texts": list(texts), **kwargs})
        out = np.zeros((len(texts), self.dim))
        out[:, 0] = 1.0
        return out


@pytest.mark.parametrize(
    "name, kind, expected",
    [
        ("qwen3-embedding-0.6b", "query", {"prompt_name": "query"}),
        ("qwen3-embedding-0.6b", "document", {}),
        (
            "bge-small-en-v1.5",
            "query",
            {"prompt": "Represent this sentence for searching relevant passages: "},
        ),
        ("bge-small-en-v1.5", "document", {}),
    ],
)
def test_kind_routes_to_the_model_query_instruction(monkeypatch, name, kind, expected):
    p = get_embedder(name)
    model = _FakeModel(p.native_dim)
    monkeypatch.setattr("providers.embeddings._load_model", lambda *a: model)

    (v,) = p.embed(["hello"], kind=kind)

    assert len(v) == p.native_dim
    (call,) = model.calls
    assert call["normalize_embeddings"] is True
    prompt_keys = {k: call[k] for k in ("prompt", "prompt_name") if k in call}
    assert prompt_keys == expected


def test_truncate_dim_on_bge_is_refused_readably():
    with pytest.raises(ValueError, match="bge-small-en-v1.5.*matryoshka"):
        get_embedder("bge-small-en-v1.5").embed(["x"], dim=128)


def test_truncate_dim_above_native_is_refused_readably():
    with pytest.raises(ValueError, match="at most 1024"):
        get_embedder("qwen3-embedding-0.6b").embed(["x"], dim=2048)


def test_importing_providers_does_not_import_torch():
    """Loading a model is expensive; merely naming one must not be.

    Run in a fresh interpreter, because this process has long since imported
    torch through docling.
    """
    script = "; ".join(
        [
            "import sys",
            "import providers.embeddings, providers.embedding_cache",
            "import plugins.index.lancedb_store, plugins.retrieve.dense, plugins.rerank.mmr",
            "from providers.embeddings import get_embedder",
            "get_embedder('qwen3-embedding-0.6b').fingerprint()",
            "bad = [m for m in ('torch', 'sentence_transformers', 'transformers') if m in sys.modules]",
            "print(','.join(bad))",
        ]
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    )
    assert proc.stdout.strip() == ""
