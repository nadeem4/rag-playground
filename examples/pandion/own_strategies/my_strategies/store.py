"""jsonl_store: a store that keeps every piece and its vector in a JSON Lines file.

A store (the index stage) reads the pieces of every document and returns a
function that writes the index into a folder Pandion gives it.
"""

import json

from pydantic import BaseModel

from pandion.extend import ArtifactType, ChunkSet, PortSpec, Stage, Transform, get_embedder, register

PIECES = "pieces.jsonl"
EMBEDDER = "embedder.txt"


# Because these settings have an `embedder` field, `embed: {use: ...}` in a
# pipeline file fills it in. A store without one embeds by itself, and then
# `embed:` must be left out.
class JsonlStoreConfig(BaseModel):
    embedder: str = "letter_counts"


@register
class JsonlStore(Transform[JsonlStoreConfig]):
    name = "jsonl_store"
    stage = Stage.INDEX
    # A store reads the port called `chunks`. It is variadic: one ChunkSet per
    # document, as a list.
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)}
    output = ArtifactType.INDEX
    # What this store offers. A retriever's `requires` is checked against it
    # when the pipeline file is read. `format` names the files it writes: the
    # built-in retrievers require format lancedb, so they are refused with this
    # store, and it comes with its own retriever, jsonl_search.
    provides = {"backends": ["dense"], "format": ["jsonl"]}
    config_model = JsonlStoreConfig
    summary = "Embeds every piece and writes the pieces and their vectors to a JSON Lines file."

    # The embedder's model and revision become part of the result id, so a
    # new revision builds a new index instead of reusing the old one.
    def fingerprint(self, config=None):
        return get_embedder((config or JsonlStoreConfig()).embedder).fingerprint()

    def apply(self, inputs, config, ctx):
        chunks = [c for payload in inputs["chunks"] for c in ChunkSet.model_validate(payload).chunks]
        # Pass the run's model settings, so an embedder that loads a model
        # finds it where the pipeline's `models:` section says.
        embedder = get_embedder(config.embedder, ctx.extras.get("models"))
        vectors = embedder.embed([c.text_to_embed for c in chunks], kind="document")
        lines = [
            json.dumps({"chunk": c.model_dump(mode="json"), "vector": v})
            for c, v in zip(chunks, vectors)
        ]

        # The work is done above, so a failure is reported as this step's
        # failure. The function below only writes the result into the folder.
        def write(folder):
            (folder / PIECES).write_text("\n".join(lines) + "\n", encoding="utf-8")
            (folder / EMBEDDER).write_text(config.embedder, encoding="utf-8")

        return write
