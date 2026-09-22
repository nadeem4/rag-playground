"""Vector similarity search over the index's dense side.

The config is two integers. Everything else a dense search needs — which model,
which revision, which width, which distance type — is read from the index's
`descriptor.json`; see `plugins.retrieve._base` for why that is not a shortcut
but the point.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import Query
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Explanation, Transform
from plugins.retrieve import _base


class DenseConfig(BaseModel):
    #: Hits returned.
    top_k: int = 5

    #: Candidates fetched before truncation. Larger than `top_k` so a downstream
    #: reranker has something to rerank.
    fetch_k: int = 20


@register
class DenseRetriever(Transform[DenseConfig]):
    name = "dense"
    stage = Stage.RETRIEVE
    inputs = {
        "index": PortSpec(ArtifactType.INDEX),
        # Ambient: the query is produced by a node that is not this one's parent,
        # so there is no edge for a linear pipeline UI to draw.
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    requires = {"index": {"backends": ["dense"]}}
    config_model = DenseConfig
    summary = (
        "Turns the question into a vector with the same model the index used, "
        "and returns the pieces whose vectors are closest. It matches meaning, "
        "so it finds paraphrases, but it can miss exact names, codes and rare "
        "words."
    )

    def explain(self, config: DenseConfig) -> Explanation:
        warning, blocking = _base._limits_warning(config.top_k, config.fetch_k)
        return Explanation(
            settings=(
                f"Fetches the {config.fetch_k} closest pieces and returns the top "
                f"{config.top_k}. {_base.passed_on(config.top_k, config.fetch_k)} "
                "The model and vector size come from the index, so they always match it."
            ),
            tradeoff=_base.TOP_K_TRADEOFF,
            warning=warning,
            blocking=blocking,
        )

    def apply(
        self, inputs: Mapping[str, Any], config: DenseConfig, ctx: RunContext
    ) -> dict[str, Any]:
        query = Query.model_validate(inputs["query"])
        table, descriptor = _base.open_index(inputs["index"])
        _base.require_backend(descriptor, "dense", self.name)

        timings: dict[str, float] = {}
        with _base.timed(timings, "embed"):
            vector = _base.embed_query(descriptor, query)
        with _base.timed(timings, "search"):
            rows = _base.dense_rows(table, vector, descriptor, config.fetch_k)

        hits = [
            _base.make_hit(
                row,
                rank=rank,
                score=_base.similarity(row["_distance"], descriptor["metric"]),
                retriever=self.name,
            )
            for rank, row in enumerate(rows[: config.top_k], start=1)
        ]

        return _base.result(
            hits,
            query=query,
            fetch_k=config.fetch_k,
            total_candidates=len(rows),
            timings_ms=timings,
        )
