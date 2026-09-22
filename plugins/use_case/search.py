"""Search: the use case that completes the pipeline with no credentials at all.

No LLM, no API key, no cost — so someone who has never bought a token can still
run a graph end to end and look at what retrieval actually returned. That makes
it the right default terminal node, and the right thing to compare a `chat`
answer against: the hits are the evidence, and this shows them undecorated.

Two details are contractual rather than cosmetic. Snippets come from
`chunk.text`, never `text_to_embed` — contextual retrieval and proposition
indexing retrieve on augmented text and must cite the original, and a citation
that quotes the augmentation is a fabricated quote. And `prior_rank` is carried
through, so the rank movement a reranker produced is visible where the results
are read, not just where they were reordered.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import Hit, Output, RetrievalResult
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Explanation, Transform


class SearchUseCaseConfig(BaseModel):
    #: Results shown, taken from the top of the candidate pool it receives.
    top_k: int = 5

    #: Characters, not bytes and not tokens. Slicing a `str` cuts on code
    #: points, so a multi-byte character can never be split in half.
    max_snippet_chars: int = 400


@register
class SearchUseCase(Transform[SearchUseCaseConfig]):
    """`retrieval_result -> output`."""

    name = "search"
    version = "1"
    stage = Stage.USE_CASE
    inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
    output = ArtifactType.OUTPUT
    config_model = SearchUseCaseConfig
    summary = (
        "Shows the retrieved pieces as a ranked list with their scores and "
        "pages. No language model, no API key and no cost: you see exactly what "
        "retrieval found."
    )

    def explain(self, config: SearchUseCaseConfig) -> Explanation:
        n, top = config.max_snippet_chars, config.top_k
        settings = (
            f"Shows the top {top} of the candidates it receives, and says how "
            f"many candidates there were. Each result shows the first {n:,} "
            "characters of its piece, with its rank, score and pages. If a "
            "reranker ran, each result also shows where it stood before."
        )
        if top < 1:
            return Explanation(
                settings=settings,
                warning="top_k must be at least 1, or nothing is shown.",
                blocking=True,
            )
        if n < 1:
            return Explanation(
                settings=settings,
                warning="max_snippet_chars must be at least 1, or every snippet is empty.",
                blocking=True,
            )
        return Explanation(
            settings=settings,
            tradeoff="Longer snippets show more context but make the list harder to scan.",
        )

    #: Formatting hits has nothing to re-roll, so the answer may be reused.
    #: `chat` will set this to False: replaying a cached generation would make
    #: asking the same question twice look deterministic when it is not.
    cacheable = True

    def apply(
        self, inputs: Mapping[str, Any], config: SearchUseCaseConfig, ctx: RunContext
    ) -> dict[str, Any]:
        result = RetrievalResult.model_validate(inputs["result"])
        return Output(
            kind="search",
            payload={
                "query_id": result.query_id,
                "total_candidates": result.total_candidates,
                "results": [
                    _row(hit, config.max_snippet_chars)
                    for hit in result.hits[: config.top_k]
                ],
            },
        ).model_dump(mode="json")


def _row(hit: Hit, max_chars: int) -> dict[str, Any]:
    chunk = hit.chunk
    return {
        "rank": hit.rank,
        "score": hit.score,
        "component_scores": hit.component_scores,
        # Null rather than absent: "this hit was never reranked" is information,
        # and a missing key would make the UI guess.
        "prior_rank": hit.prior_rank,
        "prior_score": hit.prior_score,
        "retriever": hit.retriever,
        "snippet": chunk.text[:max_chars],
        "chunk_id": chunk.id,
        "doc_id": chunk.doc_id,
        "page_span": list(chunk.page_span) if chunk.page_span else None,
        "source_element_ids": chunk.source_element_ids,
    }
