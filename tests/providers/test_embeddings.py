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
    for v in embedder.embed_truncated(["the capital of France is Paris"] * 2, dim):
        assert len(v) == dim
        assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, rel_tol=1e-9)


def test_truncation_renormalizes_rather_than_slicing_raw(embedder):
    text = "the capital of France is Paris and it is lovely in spring"
    (full,) = embedder.embed([text])
    (short,) = embedder.embed_truncated([text], 64)
    raw = full[:64]
    raw_norm = math.sqrt(sum(x * x for x in raw))
    assert raw_norm < 1.0  # the slice really is not unit length
    assert short == pytest.approx([x / raw_norm for x in raw])


def test_truncate_to_none_returns_native_vectors(embedder):
    text = "the capital of France is Paris"
    assert embedder.embed_truncated([text], None) == embedder.embed([text])


def test_truncation_is_one_directional(embedder):
    """Matryoshka only shrinks. Asking for more than native must fail loudly
    rather than zero-pad into a wrong-shaped index."""
    with pytest.raises(ValueError, match="384"):
        embedder.embed_truncated(["x"], 385)
    with pytest.raises(ValueError, match="384"):
        embedder.embed_truncated(["x"], 1024)


@pytest.mark.parametrize("dim", [0, -1])
def test_non_positive_dim_raises(embedder, dim):
    with pytest.raises(ValueError):
        embedder.embed_truncated(["x"], dim)


def test_provider_without_matryoshka_refuses_truncation():
    class NoMatryoshka(FakeDeterministicEmbedder):
        model_id = "no-matryoshka"
        supports_matryoshka = False

    p = NoMatryoshka()
    with pytest.raises(ValueError, match="matryoshka"):
        p.embed_truncated(["x"], 64)
    # None is still fine: it means "no truncation".
    assert len(p.embed_truncated(["x"], None)[0]) == 384


def test_truncated_vectors_preserve_relative_similarity(embedder):
    a, b = embedder.embed_truncated(
        ["The capital of France is Paris", "Paris is the capital of France"], 256
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
