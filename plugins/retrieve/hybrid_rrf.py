"""Reciprocal rank fusion of the dense and lexical rankings.

RRF fuses **ranks, not scores**, and that is the entire reason to prefer it over
a weighted sum here. A cosine similarity lives in [-1, 1] and a BM25 score is
unbounded and corpus-dependent; adding them requires a normalization that has to
be re-tuned for every corpus and every embedder. Ranks are already commensurable,
so `1 / (rrf_k + rank)` needs no tuning at all, and `rrf_k` only controls how
sharply the top of each list dominates.
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


class HybridRrfConfig(BaseModel):
    top_k: int = 5

    #: Fetched from *each* backend before fusion. A document has to appear in at
    #: least one list to be fusable at all, so this is what decides recall.
    fetch_k: int = 20

    #: The rank-fusion constant. 60 is the value from the original TREC paper;
    #: smaller makes rank 1 dominate, larger flattens the lists together.
    rrf_k: int = 60


@register
class HybridRrfRetriever(Transform[HybridRrfConfig]):
    name = "hybrid_rrf"
    stage = Stage.RETRIEVE
    inputs = {
        "index": PortSpec(ArtifactType.INDEX),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    requires = {"index": {"backends": ["dense", "fts"]}}
    config_model = HybridRrfConfig
    summary = (
        "Runs vector search and keyword search side by side, then merges the "
        "two ranked lists by position rather than by score (reciprocal rank "
        "fusion). A piece near the top of both lists wins, so it gets the "
        "strengths of both searches."
    )

    def explain(self, config: HybridRrfConfig) -> Explanation:
        k, fetch, top = config.rrf_k, config.fetch_k, config.top_k
        warning, blocking = _base._limits_warning(top, fetch)
        if k < 0:
            warning, blocking = (
                "rrf_k must be 0 or more; a negative value can divide by zero or "
                "rank lower places above higher ones.",
                True,
            )
        settings = (
            f"Fetches the top {fetch} from each search (fetch_k), merges them, and "
            f"returns the best {top} (top_k). Each piece scores 1/({k} + its place) "
            f"in every list it appears in (rrf_k = {k}), so first place is worth "
            f"1/{k + 1} and tenth place 1/{k + 10}."
        )
        tradeoff = (
            "A small rrf_k lets the first few places of each list dominate; a "
            "large one, such as the usual 60, flattens the lists so pieces found "
            "by both searches rise. A larger fetch_k lets more pieces take part in "
            "the merge, for a slightly slower search."
        )
        return Explanation(
            settings=settings, tradeoff=tradeoff, warning=warning, blocking=blocking
        )

    def apply(
        self, inputs: Mapping[str, Any], config: HybridRrfConfig, ctx: RunContext
    ) -> dict[str, Any]:
        query = Query.model_validate(inputs["query"])
        table, descriptor = _base.open_index(inputs["index"])
        for backend in ("dense", "fts"):
            _base.require_backend(descriptor, backend, self.name)

        timings: dict[str, float] = {}
        with _base.timed(timings, "dense"):
            vector = _base.embed_query(descriptor, query)
            dense = _base.dense_rows(table, vector, descriptor, config.fetch_k)
        with _base.timed(timings, "bm25"):
            lexical = _base.fts_rows(table, query, config.fetch_k)

        with _base.timed(timings, "fuse"):
            hits = self._fuse(dense, lexical, descriptor, config)

        return _base.result(
            hits,
            query=query,
            fetch_k=config.fetch_k,
            # Unique documents across both lists — the pool fusion actually chose
            # from, which is more than either list contributed on its own.
            total_candidates=len({row["id"] for row in dense + lexical}),
            timings_ms=timings,
        )

    def _fuse(
        self,
        dense: list[dict[str, Any]],
        lexical: list[dict[str, Any]],
        descriptor: dict[str, Any],
        config: HybridRrfConfig,
    ) -> list[Any]:
        rows: dict[str, dict[str, Any]] = {}
        scores: dict[str, float] = {}
        components: dict[str, dict[str, float]] = {}
        best_rank: dict[str, int] = {}

        lists = (
            ("dense", dense, lambda r: _base.similarity(r["_distance"], descriptor["metric"])),
            ("bm25", lexical, lambda r: float(r["_score"])),
        )
        for label, ranked, raw_score in lists:
            for rank, row in enumerate(ranked, start=1):
                doc = row["id"]
                rows.setdefault(doc, row)
                scores[doc] = scores.get(doc, 0.0) + 1.0 / (config.rrf_k + rank)
                # Only the lists a document actually appeared in get a component.
                # A zero would read as "scored zero" rather than "not retrieved".
                components.setdefault(doc, {})[label] = raw_score(row)
                best_rank[doc] = min(best_rank.get(doc, rank), rank)

        # Ties are broken by the better contributing rank, then by id, so the
        # output is deterministic and therefore cacheable.
        order = sorted(scores, key=lambda doc: (-scores[doc], best_rank[doc], doc))

        return [
            _base.make_hit(
                rows[doc],
                rank=rank,
                score=scores[doc],
                retriever=self.name,
                component_scores=components[doc],
            )
            for rank, doc in enumerate(order[: config.top_k], start=1)
        ]
