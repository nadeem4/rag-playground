"""Reciprocal rank fusion of the dense and lexical rankings.

RRF fuses **ranks, not scores**, and that is the entire reason to prefer it over
a weighted sum here. A cosine similarity lives in [-1, 1] and a BM25 score is
unbounded and corpus-dependent; adding them requires a normalization that has to
be re-tuned for every corpus and every embedder. Ranks are already commensurable,
so `1 / (rrf_k + rank)` needs no tuning at all, and `rrf_k` only controls how
sharply the top of each list dominates. `dense_weight` and `bm25_weight`
multiply each list's term, so one search can count for more than the other.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping

from pydantic import Field, model_validator

from pandion.artifacts import ArtifactType
from pandion.ids import AddedSettings
from pandion.payloads import Query
from pandion.ports import PortSpec, RunContext, Stage, set_note
from pandion.registry import register
from pandion.transform import Explanation, Transform
from pandion.plugins.retrieve import _base, _prf

NO_EXPANSION_NOTE = "No expansion: the dense pass found nothing to borrow from."


def filtered_out_note(docs: int) -> str:
    """The dense pass found hits, but none of their words could be added."""
    return (
        f"No expansion: every word in the top {docs} dense hits was a common "
        "word, a number or already in the question."
    )


class HybridRrfConfig(AddedSettings):
    added = ("dense_weight", "bm25_weight")

    #: The candidate pool handed on, and also how deep each search goes before
    #: fusion. A document has to appear in at least one list to be fusable at
    #: all, so this is what decides recall. The next step narrows the pool.
    top_k: int = Field(
        default=20,
        title="Candidates",
        description=(
            "How many pieces the search hands on. The rerank or answer step "
            "after it keeps fewer."
        ),
    )

    #: The rank-fusion constant. 60 is the value from the original TREC paper;
    #: smaller makes rank 1 dominate, larger flattens the lists together.
    rrf_k: int = Field(
        default=60,
        title="Fusion constant",
        description=(
            "How the two ranked lists are blended. 60 is the usual value: "
            "smaller lets each list's first picks count more, larger evens them"
            " out."
        ),
    )

    query_expansion: Literal["none", "prf"] = Field(
        title="Expand the question",
        default="none",
        description=(
            "'none' runs the keyword search on the question as written. 'prf' "
            "(pseudo-relevance feedback) adds the most distinctive words of the"
            " top dense hits to the keyword search; the dense search is "
            "unchanged."
        ),
    )
    # 2 hits and 6 words, measured: on a resume question that shares no word
    # with the document, this was the one setting that lifted the right piece
    # to rank 3 under all four chunkers in the measurement script, and to rank 4 in
    # the app's default pipeline. More hits or more words borrow from
    # pieces that are off topic and pull the keyword search after them.
    prf_docs: int = Field(
        title="PRF hits",
        default=2,
        ge=1,
        le=10,
        description=(
            "When PRF is on: how many of the top dense hits the added words are"
            " borrowed from."
        ),
    )
    prf_terms: int = Field(
        title="PRF words",
        default=6,
        ge=1,
        le=20,
        description=(
            "When PRF is on: how many words are added to the keyword search, "
            "chosen by tf-idf (frequent in those hits, rare in the whole "
            "document)."
        ),
    )
    #: Added after version 2's results were stored; see pandion.ids.AddedSettings.
    dense_weight: float = Field(
        default=1.0,
        ge=0,
        title="Meaning weight",
        description=(
            "How much the vector (meaning) search counts in the fusion. Each "
            "list's 1/(rrf_k + place) is multiplied by its weight. 1 and 1 "
            "count both searches the same."
        ),
    )
    bm25_weight: float = Field(
        default=1.0,
        ge=0,
        title="Keyword weight",
        description=(
            "How much the keyword search counts in the fusion. Set it above "
            "the meaning weight, for example 2, to favour exact names, codes "
            "and part numbers."
        ),
    )

    @model_validator(mode="after")
    def _one_search_counts(self) -> "HybridRrfConfig":
        if self.dense_weight == 0 and self.bm25_weight == 0:
            raise ValueError(
                "dense_weight and bm25_weight are both 0, so no search would "
                "count. Give at least one of them a weight above 0."
            )
        return self


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
    requires = {"index": {"backends": ["dense", "fts"], "format": ["lancedb"]}}
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
            f"tenth place 1/{k + 10}. " + _weight_words(config) + f"{_base.pool_words(top)} "
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
            vector = _base.embed_query(descriptor, query, ctx.extras)
            dense = _base.dense_rows(table, vector, descriptor, config.top_k)

        expanded: str | None = None
        terms: list[str] = []
        if config.query_expansion == "prf":
            with _base.timed(timings, "expand"):
                expanded, terms = self._expand(table, dense, query, config)
            docs = min(config.prf_docs, len(dense))
            if terms:
                set_note(
                    ctx,
                    f"Expanded the keyword search with {len(terms)} terms from "
                    f"the top {docs} dense hits: {', '.join(terms)}.",
                )
            elif not dense:
                set_note(ctx, NO_EXPANSION_NOTE)
            else:
                set_note(ctx, filtered_out_note(docs))

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
            ("dense", dense, config.dense_weight, lambda r: _base.similarity(r["_distance"], descriptor["metric"])),
            ("bm25", lexical, config.bm25_weight, lambda r: float(r["_score"])),
        )
        for label, ranked, weight, raw_score in lists:
            for rank, row in enumerate(ranked, start=1):
                doc = row["id"]
                rows.setdefault(doc, row)
                scores[doc] = scores.get(doc, 0.0) + weight / (config.rrf_k + rank)
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


def _weight_words(config: HybridRrfConfig) -> str:
    """What the list weights do, when they are not both 1."""
    if config.dense_weight == 1 and config.bm25_weight == 1:
        return ""
    return (
        f"The meaning search's term is multiplied by {config.dense_weight:g} "
        f"(dense_weight) and the keyword search's by {config.bm25_weight:g} "
        "(bm25_weight). "
    )


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
