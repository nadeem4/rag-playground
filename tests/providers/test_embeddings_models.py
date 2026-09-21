"""The real embedders. Slow: the first run downloads the models.

Qwen3-Embedding-0.6B is about 1.2 GB and bge-small-en-v1.5 about 130 MB, into
the Hugging Face cache (`~/.cache/huggingface/hub`). Run with `-m models`.
"""

from __future__ import annotations

import math

import pytest

from providers.embeddings import get_embedder

pytestmark = pytest.mark.models

QUESTION = "What is the capital of France?"
ANSWER = "The capital of France is Paris."
DISTRACTORS = [
    "France is famous for its wine and cheese.",
    "Berlin is the capital of Germany.",
    "The Eiffel Tower was completed in 1889.",
    "Photosynthesis converts sunlight into chemical energy.",
]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def norm(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def ranking(name: str, dim: int | None = None) -> list[str]:
    p = get_embedder(name)
    passages = DISTRACTORS + [ANSWER]
    (q,) = p.embed([QUESTION], kind="query", dim=dim)
    docs = p.embed(passages, kind="document", dim=dim)
    scores = {text: cosine(q, d) for text, d in zip(passages, docs)}
    return sorted(scores, key=scores.get, reverse=True)


def test_qwen3_ranks_the_answer_first():
    """A real semantic check: the distractors share words with the question."""
    assert ranking("qwen3-embedding-0.6b")[0] == ANSWER


@pytest.mark.parametrize("dim", [1024, 512, 256, 128, 64])
def test_qwen3_matryoshka_vectors_are_unit_length(dim):
    p = get_embedder("qwen3-embedding-0.6b")
    for v in p.embed([ANSWER, QUESTION], dim=dim):
        assert len(v) == dim
        assert math.isclose(norm(v), 1.0, rel_tol=1e-6)


def test_qwen3_still_ranks_the_answer_first_at_256():
    assert ranking("qwen3-embedding-0.6b", dim=256)[0] == ANSWER


def test_qwen3_query_and_document_embeddings_differ():
    """The query instruction is applied: same string, different vectors."""
    p = get_embedder("qwen3-embedding-0.6b")
    (q,) = p.embed([QUESTION], kind="query")
    (d,) = p.embed([QUESTION], kind="document")
    assert cosine(q, d) < 0.999


def test_bge_works():
    p = get_embedder("bge-small-en-v1.5")
    vecs = p.embed([ANSWER, QUESTION], kind="document")
    assert all(len(v) == 384 and math.isclose(norm(v), 1.0, rel_tol=1e-6) for v in vecs)
    assert ranking("bge-small-en-v1.5")[0] == ANSWER
