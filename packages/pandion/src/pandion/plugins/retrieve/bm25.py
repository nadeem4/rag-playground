"""Lexical search over the index's full-text side.

BM25 is the baseline dense retrieval has to beat, and on exact identifiers,
product codes and rare proper nouns it frequently does not — which is the whole
reason `hybrid_rrf` exists. Keeping it as its own plugin makes that comparison a
one-node change in the graph.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel, Field

from pandion.artifacts import ArtifactType
from pandion.payloads import Query
from pandion.ports import PortSpec, RunContext, Stage
from pandion.registry import register
from pandion.transform import Explanation, Transform
from pandion.plugins.retrieve import _base


class Bm25Config(BaseModel):
    #: The candidate pool handed on; the next step narrows it.
    top_k: int = Field(
        default=20,
        title="Candidates",
        description=(
            "How many pieces the search hands on. The rerank or answer step "
            "after it keeps fewer."
        ),
    )


@register
class Bm25Retriever(Transform[Bm25Config]):
    name = "bm25"
    stage = Stage.RETRIEVE
    inputs = {
        "index": PortSpec(ArtifactType.INDEX),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    requires = {"index": {"backends": ["fts"], "format": ["lancedb"]}}
    config_model = Bm25Config
    summary = (
        "Scores pieces by the words they share with the question, counting rare "
        "words for more than common ones (the BM25 formula). It finds exact "
        "names, codes and terms that vector search can miss, but it does not "
        "know that different words can mean the same thing."
    )

    def explain(self, config: Bm25Config) -> Explanation:
        warning, blocking = _base._limits_warning(config.top_k)
        return Explanation(
            settings=(
                f"Finds the {config.top_k} best keyword matches. "
                f"{_base.pool_words(config.top_k)} "
                "It needs an index built with build_fts on."
            ),
            tradeoff=_base.TOP_K_TRADEOFF,
            warning=warning,
            blocking=blocking,
        )

    def apply(
        self, inputs: Mapping[str, Any], config: Bm25Config, ctx: RunContext
    ) -> dict[str, Any]:
        query = Query.model_validate(inputs["query"])
        collection, descriptor = _base.open_index(inputs["index"])
        # Checked here and not only at graph validation: `provides` says what the
        # index transform *can* build, the descriptor says what it *did*.
        roles = _base.caller_roles(query, ctx.extras)
        _base.check_pairing(inputs["index"], descriptor, "fts", self.name, roles)
        where = _base.search_filter(query, descriptor, roles)

        timings: dict[str, float] = {}
        with _base.timed(timings, "search"):
            rows = _base.lexical_hits(collection, query, config.top_k, where, roles, self.name)

        # The store's score is already higher-is-better and sorted, so no sign
        # flip and no re-sort.
        hits = [
            _base.make_hit(row, rank=rank, score=row.score, retriever=self.name)
            for rank, row in enumerate(rows, start=1)
        ]

        return _base.result(
            hits,
            query=query,
            fetch_k=config.top_k,
            total_candidates=len(rows),
            timings_ms=timings,
        )
