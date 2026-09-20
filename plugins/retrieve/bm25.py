"""Lexical search over the index's full-text side.

BM25 is the baseline dense retrieval has to beat, and on exact identifiers,
product codes and rare proper nouns it frequently does not — which is the whole
reason `hybrid_rrf` exists. Keeping it as its own plugin makes that comparison a
one-node change in the graph.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import Query
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Transform
from plugins.retrieve import _base


class Bm25Config(BaseModel):
    top_k: int = 5
    fetch_k: int = 20


@register
class Bm25Retriever(Transform[Bm25Config]):
    name = "bm25"
    stage = Stage.RETRIEVE
    inputs = {
        "index": PortSpec(ArtifactType.INDEX),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    requires = {"index": {"backends": ["fts"]}}
    config_model = Bm25Config

    def apply(
        self, inputs: Mapping[str, Any], config: Bm25Config, ctx: RunContext
    ) -> dict[str, Any]:
        query = Query.model_validate(inputs["query"])
        table, descriptor = _base.open_index(inputs["index"])
        # Checked here and not only at graph validation: `provides` says what the
        # index transform *can* build, the descriptor says what it *did*.
        _base.require_backend(descriptor, "fts", self.name)

        timings: dict[str, float] = {}
        with _base.timed(timings, "search"):
            rows = _base.fts_rows(table, query, config.fetch_k)

        # LanceDB's `_score` is the BM25 score: already higher-is-better and
        # already sorted, so no sign flip and no re-sort.
        hits = [
            _base.make_hit(
                row, rank=rank, score=row["_score"], retriever=self.name
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
