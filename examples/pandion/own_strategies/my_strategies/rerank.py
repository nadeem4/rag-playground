"""shortest_first: a reranker that puts shorter pieces first.

A reranker reads the hits of the step before it and returns them in a new
order, often fewer of them. Rerankers can be stacked: `rerank:` takes a list.
"""

from pydantic import BaseModel

from pandion.extend import ArtifactType, PortSpec, RetrievalResult, Stage, Transform, register


class ShortestFirstConfig(BaseModel):
    top_k: int = 3


@register
class ShortestFirst(Transform[ShortestFirstConfig]):
    name = "shortest_first"
    stage = Stage.RERANK
    # A reranker reads the port called `result`.
    inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
    output = ArtifactType.RETRIEVAL_RESULT
    config_model = ShortestFirstConfig
    summary = "Puts the shortest pieces first and keeps top_k of them."

    def apply(self, inputs, config, ctx):
        result = RetrievalResult.model_validate(inputs["result"])
        hits = sorted(result.hits, key=lambda hit: len(hit.chunk.text))[: config.top_k]
        for rank, hit in enumerate(hits, start=1):
            # Keep where each hit was before, so you can see what moved.
            hit.prior_rank, hit.prior_score = hit.rank, hit.score
            hit.rank = rank
        result.hits = hits
        return result.model_dump(mode="json")
