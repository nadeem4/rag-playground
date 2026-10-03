"""A cross-encoder reranker: the stage people mean when they say "rerank".

A retriever scores the question and each piece separately and compares the
two. A cross-encoder reads the question and one piece together, as a single
input, and returns one relevance score. That is slower, so it runs only on the
retriever's small candidate pool, and more accurate, because every word of the
question can attend to every word of the piece.

It follows the `mmr` contract: `retrieval_result -> retrieval_result`, an
ambient `query`, and every returned hit carries `prior_rank` and `prior_score`
so the bench can show what moved. Unlike MMR it rescores: `score` becomes the
cross-encoder's score.

The model loads lazily and once per process, like the embedders in
`providers/embeddings.py`: importing this module never imports torch or
sentence-transformers.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import Hit, Query, RetrievalResult
from core.ports import PortSpec, RunContext, Stage, set_note
from core.registry import register
from core.transform import Explanation, Transform

CrossEncoderModel = Literal[
    "cross-encoder/ms-marco-MiniLM-L-6-v2",
    "BAAI/bge-reranker-base",
    "BAAI/bge-reranker-v2-m3",
]

#: Short name for notes, and the size in words for `explain`.
_SHORT_NAMES: dict[str, str] = {
    "cross-encoder/ms-marco-MiniLM-L-6-v2": "MiniLM",
    "BAAI/bge-reranker-base": "bge-reranker-base",
    "BAAI/bge-reranker-v2-m3": "bge-reranker-v2-m3",
}
_SIZES: dict[str, str] = {
    "cross-encoder/ms-marco-MiniLM-L-6-v2": "a small model of 22 million parameters",
    "BAAI/bge-reranker-base": "a medium model of 278 million parameters",
    "BAAI/bge-reranker-v2-m3": "a large model of 568 million parameters",
}


class CrossEncoderConfig(BaseModel):
    model: CrossEncoderModel = Field(
        default="cross-encoder/ms-marco-MiniLM-L-6-v2",
        description=(
            "A sentence-transformers CrossEncoder. MiniLM is small and fast; "
            "bge-reranker-base is stronger; bge-reranker-v2-m3 is strongest and "
            "slow on a CPU."
        ),
    )
    #: How many it keeps from the retriever's candidate pool (20 by default).
    top_k: int = 5


_LOAD_LOCK = threading.Lock()
_MODELS: dict[str, Any] = {}


def _load(model_id: str) -> Any:
    """Load a cross-encoder once per process; the import happens here.

    The lock stops two threads racing a first load from each pulling the model
    into memory, the same rule as `providers.embeddings._load_model`.
    """
    with _LOAD_LOCK:
        if model_id not in _MODELS:
            from sentence_transformers import CrossEncoder

            _MODELS[model_id] = CrossEncoder(model_id, device="cpu")
        return _MODELS[model_id]


@register
class CrossEncoderRerank(Transform[CrossEncoderConfig]):
    """`retrieval_result -> retrieval_result`, so it stacks with other rerankers."""

    name = "cross_encoder"
    version = "1"
    stage = Stage.RERANK
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    config_model = CrossEncoderConfig
    summary = (
        "A cross-encoder reads the question and each candidate piece together "
        "and gives the pair one relevance score. It is slower than the "
        "retriever's comparison but more accurate, so it only reorders the "
        "small pool of candidates the retriever found."
    )

    def fingerprint(self, config: CrossEncoderConfig | None = None) -> str:
        return (config or CrossEncoderConfig()).model

    def explain(self, config: CrossEncoderConfig) -> Explanation:
        top = config.top_k
        settings = (
            f"It scores every candidate with {_SHORT_NAMES[config.model]}, "
            f"{_SIZES[config.model]}, and keeps the {top} best from the pool the "
            "retriever hands on (20 by default)."
        )
        tradeoff = (
            "A stronger model ranks more accurately, but it costs seconds per "
            "question on a CPU, where MiniLM takes well under a second."
        )
        warning, blocking = None, False
        if top < 1:
            warning, blocking = "top_k must be at least 1.", True
        return Explanation(
            settings=settings, tradeoff=tradeoff, warning=warning, blocking=blocking
        )

    def apply(
        self, inputs: Mapping[str, Any], config: CrossEncoderConfig, ctx: RunContext
    ) -> dict[str, Any]:
        result = RetrievalResult.model_validate(inputs["result"])
        query = Query.model_validate(inputs["query"])
        hits = result.hits

        if not hits:
            return result.model_dump(mode="json")

        prior_ids = [hit.chunk.id for hit in hits]
        for hit in hits:
            hit.prior_rank = hit.rank
            hit.prior_score = hit.score

        # Load before starting the clock: the note reports scoring time, and a
        # first run's download would otherwise read as a slow reranker.
        model = _load(config.model)
        started = time.perf_counter()
        scores = [
            float(s)
            for s in model.predict([(query.text, hit.chunk.text) for hit in hits])
        ]
        elapsed = time.perf_counter() - started

        # A stable sort on the negated score, so ties keep the retriever's order.
        order = sorted(range(len(hits)), key=lambda i: -scores[i])[: config.top_k]
        result.hits = [
            _rescored(hits[index], scores[index], rank)
            for rank, index in enumerate(order, start=1)
        ]
        result.total_candidates = len(hits)

        kept = len(result.hits)
        moved = sum(
            1 for hit, prior in zip(result.hits, prior_ids) if hit.chunk.id != prior
        )
        set_note(
            ctx,
            f"Scored {len(hits)} candidates with {_SHORT_NAMES[config.model]} in "
            f"{elapsed:.1f} s. {moved} of the top {kept} changed place.",
        )
        return result.model_dump(mode="json")


def _rescored(hit: Hit, score: float, rank: int) -> Hit:
    hit.score = score
    hit.rank = rank
    return hit
