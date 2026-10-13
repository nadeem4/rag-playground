"""jsonl_search: a retriever that searches the file jsonl_store wrote.

A retriever reads the index and the question, and returns a RetrievalResult:
the hits, best first.
"""

import json
from pathlib import Path

from pydantic import BaseModel

from pandion.extend import (
    ArtifactType, Chunk, Hit, PortSpec, Query, RetrievalResult, Stage, Transform, get_embedder, register,
)

from my_strategies.store import EMBEDDER, PIECES


class JsonlSearchConfig(BaseModel):
    top_k: int = 3


@register
class JsonlSearch(Transform[JsonlSearchConfig]):
    name = "jsonl_search"
    stage = Stage.RETRIEVE
    inputs = {
        # The index arrives as the folder the store wrote into.
        "index": PortSpec(ArtifactType.INDEX),
        # The question comes from the rewrite step. `ambient` means Pandion
        # finds that step for you, so no wiring is needed.
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    # Only a store that provides the dense backend and writes jsonl files can
    # be searched by this. Asking for the format stops it pairing with a store
    # whose files it cannot read, such as lancedb: that pipeline file is
    # refused when it is read.
    requires = {"index": {"backends": ["dense"], "format": ["jsonl"]}}
    config_model = JsonlSearchConfig
    summary = "Embeds the question with the store's embedder and returns the closest pieces."

    def apply(self, inputs, config, ctx):
        folder = Path(inputs["index"])
        query = Query.model_validate(inputs["query"])
        # Embed the question with the same embedder the store used, and the
        # run's model settings.
        embedder = get_embedder((folder / EMBEDDER).read_text(encoding="utf-8"), ctx.extras.get("models"))
        [question] = embedder.embed([query.text], kind="query")

        rows = [json.loads(line) for line in (folder / PIECES).read_text(encoding="utf-8").splitlines()]
        # The vectors are unit length, so the dot product is the cosine.
        scored = sorted(
            ((sum(a * b for a, b in zip(question, row["vector"])), row) for row in rows),
            key=lambda pair: pair[0],
            reverse=True,
        )[: config.top_k]
        hits = [
            Hit(chunk=Chunk.model_validate(row["chunk"]), score=score, rank=rank, retriever=self.name)
            for rank, (score, row) in enumerate(scored, start=1)
        ]
        return RetrievalResult(hits=hits, fetch_k=config.top_k, total_candidates=len(rows)).model_dump(mode="json")
