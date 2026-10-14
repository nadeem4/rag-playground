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

The model loads lazily and once per process per device, like the embedders in
`pandion.embeddings`: importing this module never imports torch or
sentence-transformers, which come with the `local` extra. Where the model is
kept, whether it may download and the device come from the run's
`context_extras["models"]` (`pandion.models.ModelSettings`), never from the
config, so they are not part of the recipe hash. The model is loaded at the
commit in `PINNED`, or at `revision` when it is set.
"""

from __future__ import annotations

import threading
import time
from typing import Any, ClassVar, Literal, Mapping

from pydantic import Field

from pandion.artifacts import ArtifactType
from pandion.errors import require
from pandion.ids import AddedSettings
from pandion.models import ModelSettings, check_downloaded, resolve_device
from pandion.payloads import Hit, Query, RetrievalResult
from pandion.ports import PortSpec, RunContext, Stage, set_note
from pandion.registry import register
from pandion.transform import Explanation, Transform

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

#: The commit each model is loaded at: its main branch on Hugging Face on
#: 2026-10-13. Pinned, so scores do not drift when a model's main branch moves.
PINNED: dict[str, str] = {
    "cross-encoder/ms-marco-MiniLM-L-6-v2": "233902d25c440f23af6f7d6e94d2946bac0bee0a",
    "BAAI/bge-reranker-base": "2cfc18c9415c912f9d8155881c133215df768a70",
    "BAAI/bge-reranker-v2-m3": "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
}


class CrossEncoderConfig(AddedSettings):
    added: ClassVar[tuple[str, ...]] = ("revision",)

    model: CrossEncoderModel = Field(
        title="Model",
        default="cross-encoder/ms-marco-MiniLM-L-6-v2",
        description=(
            "A sentence-transformers CrossEncoder. MiniLM is small and fast; "
            "bge-reranker-base is stronger; bge-reranker-v2-m3 is strongest and"
            " slow on a CPU."
        ),
    )
    #: How many it keeps from the retriever's candidate pool (20 by default).
    top_k: int = Field(
        default=5,
        title="Pieces kept",
        description="How many pieces the reranker keeps.",
    )
    #: Added after version 2's results were stored; see pandion.ids.AddedSettings.
    revision: str = Field(
        default="",
        title="Revision",
        description=(
            "The model's commit on Hugging Face. Empty uses the commit Pandion "
            "pins for the model, so scores do not change when the model is updated."
        ),
    )


_LOAD_LOCK = threading.Lock()
_MODELS: dict[tuple[str, str, str], Any] = {}


def _load(model_id: str, settings: ModelSettings | None = None) -> Any:
    """The model at the revision Pandion pins for it (main for any other id)."""
    return _load_at(model_id, PINNED.get(model_id, "main"), settings)


def _load_at(model_id: str, revision: str, settings: ModelSettings | None = None) -> Any:
    """Load a cross-encoder once per process, revision and device; the import happens here.

    The lock stops two threads racing a first load from each pulling the model
    into memory, the same rule as `pandion.embeddings._load_model`.
    """
    settings = settings or ModelSettings()
    with _LOAD_LOCK:
        device = resolve_device(settings.device)
        key = (model_id, revision, device)
        if key not in _MODELS:
            check_downloaded(model_id, revision, settings)
            st = require(
                "sentence_transformers", extra="local", step="The cross_encoder reranker"
            )
            _MODELS[key] = st.CrossEncoder(
                model_id,
                revision=revision,
                device=device,
                cache_folder=str(settings.cache_dir) if settings.cache_dir else None,
                local_files_only=settings.download == "never",
            )
        return _MODELS[key]


def _model_for(config: CrossEncoderConfig, settings: ModelSettings | None) -> Any:
    """The model the settings name: pinned when `revision` is empty."""
    if not config.revision:
        return _load(config.model, settings)
    return _load_at(config.model, config.revision, settings)


@register
class CrossEncoderRerank(Transform[CrossEncoderConfig]):
    """`retrieval_result -> retrieval_result`, so it stacks with other rerankers."""

    name = "cross_encoder"
    extra = "local"
    version = "2"
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
        config = config or CrossEncoderConfig()
        return config.model if not config.revision else f"{config.model}@{config.revision}"

    def explain(self, config: CrossEncoderConfig) -> Explanation:
        top = config.top_k
        settings = (
            f"It scores every candidate with {_SHORT_NAMES[config.model]}, "
            f"{_SIZES[config.model]}, and keeps the {top} best from the pool the "
            "retriever hands on (20 by default). It judges each piece against "
            "the question as you typed it, even when the question was rewritten "
            "for retrieval."
        )
        tradeoff = (
            "A stronger model ranks more accurately, but it costs seconds per "
            "question on a CPU, where MiniLM takes well under a second. Scores "
            "are on the model's own scale and differ between models, so compare "
            "the order, not the numbers."
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
        extras = ctx.extras if ctx is not None else {}
        model = _model_for(config, extras.get("models"))
        started = time.perf_counter()
        scores = [
            float(s)
            for s in model.predict([(query.asked, hit.chunk.text) for hit in hits])
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
            f"{_seconds(elapsed)}. {moved} of the top {kept} changed place.",
        )
        return result.model_dump(mode="json")


def _seconds(elapsed: float) -> str:
    """One decimal place, except that a warm model's few milliseconds would
    print as "0.0 s", which reads as if nothing ran."""
    return "under 0.1 s" if elapsed < 0.05 else f"{elapsed:.1f} s"


def _rescored(hit: Hit, score: float, rank: int) -> Hit:
    hit.score = score
    hit.rank = rank
    return hit
