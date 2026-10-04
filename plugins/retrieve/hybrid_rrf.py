"""Reciprocal rank fusion of the dense and lexical rankings.

RRF fuses **ranks, not scores**, and that is the entire reason to prefer it over
a weighted sum here. A cosine similarity lives in [-1, 1] and a BM25 score is
unbounded and corpus-dependent; adding them requires a normalization that has to
be re-tuned for every corpus and every embedder. Ranks are already commensurable,
so `1 / (rrf_k + rank)` needs no tuning at all, and `rrf_k` only controls how
sharply the top of each list dominates.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import Query
from core.ports import PortSpec, RunContext, Stage, set_note
from core.registry import register
from core.transform import Explanation, Transform
from plugins.retrieve import _base, _prf

NO_EXPANSION_NOTE = "No expansion: the dense pass found nothing to borrow from."


class HybridRrfConfig(BaseModel):
    #: The candidate pool handed on, and also how deep each search goes before
    #: fusion. A document has to appear in at least one list to be fusable at
    #: all, so this is what decides recall. The next step narrows the pool.
    top_k: int = 20

    #: The rank-fusion constant. 60 is the value from the original TREC paper;
    #: smaller makes rank 1 dominate, larger flattens the lists together.
    rrf_k: int = 60

    query_expansion: Literal["none", "prf"] = Field(
        default="none",
        description="'none' runs the keyword search on the question as written. "
        "'prf' (pseudo-relevance feedback) adds the most distinctive words of "
        "the top dense hits to the keyword search; the dense search is unchanged.",
    )
    # 2 hits and 6 words, measured: on a resume question that shares no word
    # with the document, this was the one setting that lifted the right piece
    # to rank 3 under all four chunkers. More hits or more words borrow from
    # pieces that are off topic and pull the keyword search after them.
    prf_docs: int = Field(
        default=2,
        ge=1,
        le=10,
        description="With query_expansion 'prf': how many of the top dense hits "
        "the added words are borrowed from.",
    )
    prf_terms: int = Field(
        default=6,
        ge=1,
        le=20,
        description="With query_expansion 'prf': how many words are added to the "
        "keyword search, chosen by tf-idf (frequent in those hits, rare in the "
        "whole document).",
    )


@register
class HybridRrfRetriever(Transform[HybridRrfConfig]):
    name = "hybrid_rrf"
    version = "2"
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
        k, top = config.rrf_k, config.top_k
        warning, blocking = _base._limits_warning(top)
        if k < 0:
            warning, blocking = (
                "rrf_k must be 0 or more; a negative value can divide by zero or "
                "rank lower places above higher ones.",
                True,
            )
        settings = (
            f"Takes the top {top} from each search, merges them, and keeps the "
            f"best {top}. Each piece scores 1/({k} + its place) in every list it "
            f"appears in (rrf_k = {k}), so first place is worth 1/{k + 1} and "
            f"tenth place 1/{k + 10}. {_base.pool_words(top)} "
            + _expansion_words(config)
        )
        tradeoff = (
            "A small rrf_k lets the first few places of each list dominate; a "
            "large one, such as the usual 60, flattens the lists so pieces found "
            "by both searches rise. " + _base.TOP_K_TRADEOFF
        )
        if config.query_expansion == "prf":
            tradeoff += (
                " Borrowed words help a question that shares no word with the "
                "document, but when the top dense hits are off topic, their "
                "words pull the keyword search off topic too."
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
            dense = _base.dense_rows(table, vector, descriptor, config.top_k)

        expanded: str | None = None
        terms: list[str] = []
        if config.query_expansion == "prf":
            with _base.timed(timings, "expand"):
                expanded, terms = self._expand(table, dense, query, config)
            if terms:
                set_note(
                    ctx,
                    f"Expanded the keyword search with {len(terms)} terms from "
                    f"the top {min(config.prf_docs, len(dense))} dense hits: "
                    f"{', '.join(terms)}.",
                )
            else:
                set_note(ctx, NO_EXPANSION_NOTE)

        with _base.timed(timings, "bm25"):
            lexical = _base.fts_rows(table, query, config.top_k, text=expanded)

        with _base.timed(timings, "fuse"):
            hits = self._fuse(dense, lexical, descriptor, config)

        return _base.result(
            hits,
            query=query,
            fetch_k=config.top_k,
            # Unique documents across both lists — the pool fusion actually chose
            # from, which is more than either list contributed on its own.
            total_candidates=len({row["id"] for row in dense + lexical}),
            timings_ms=timings,
            expanded_query=expanded,
            expansion_terms=terms,
        )

    def _expand(
        self,
        table: Any,
        dense: list[dict[str, Any]],
        query: Query,
        config: HybridRrfConfig,
    ) -> tuple[str | None, list[str]]:
        """The expanded keyword query and the words it added, or `(None, [])`.

        Words come from the indexed text of the top dense rows, weighed against
        the indexed text of every row, so the idf is the document's own. The
        question's words go first, so the search still looks for them.
        """
        if not dense:
            return None, []
        top = [row[_base.TEXT_COLUMN] for row in dense[: config.prf_docs]]
        terms = _prf.select_terms(
            top, _base.indexed_texts(table), query.text, config.prf_terms
        )
        if not terms:
            return None, []
        return f"{query.text} {' '.join(terms)}", terms

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


def _expansion_words(config: HybridRrfConfig) -> str:
    """What `query_expansion` does with these settings, by the parameters' names."""
    if config.query_expansion != "prf":
        return (
            "query_expansion is none, so the keyword search uses the question "
            f"as written. Set it to prf to add the {config.prf_terms} most "
            f"distinctive words (prf_terms) of the top {config.prf_docs} dense "
            "hits (prf_docs) to the keyword search."
        )
    return (
        f"query_expansion is prf: the keyword search also looks for the "
        f"{config.prf_terms} most distinctive words (prf_terms) of the top "
        f"{config.prf_docs} dense hits (prf_docs), chosen by tf-idf against "
        "the whole document, skipping common words, numbers and the "
        "question's own words. The dense pass is unchanged and always "
        "searches the question as written. When the dense pass finds nothing, "
        "the keyword search uses the question as written."
    )
