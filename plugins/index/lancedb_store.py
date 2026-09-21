"""A LanceDB index: one table, dense vectors and a full-text index side by side.

Three things here are load-bearing and easy to get subtly wrong.

*The payload is a callable, not a directory.* `DirectorySerializer.write` calls
it with the destination the store has chosen, and the store then commits that
destination atomically. The database is nevertheless *built* in `ctx.output_dir`
during `apply()`, and the callable only copies the finished tree into place: a
build that fails must fail inside `apply()`, where the executor records it as a
node failure, rather than inside `store.put`, where it would abort the whole run.

*The capability descriptor is written into the directory.* Spec §5 calls it
artifact meta, but a downstream transform is handed payloads only — it never
sees `Artifact.meta` — so meta alone could not tell a retriever which embedder
to query with. `descriptor.json` inside the index is the channel that actually
reaches the consumer, and it survives a cache hit for free because it is part of
the committed artifact. The same dict is also published on `ctx.extras["meta"]`,
which the executor folds into `Artifact.meta` for the store and the UI.

*Vectors come from `chunk.text_to_embed`.* That is the contextual-retrieval
seam: an augmented text is retrieved on while the original is cited. The full
chunk travels alongside in `chunk_json` so the citation stays exact.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Callable, Literal, Mapping

import lancedb
import pyarrow as pa
from lancedb.index import FTS
from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import ChunkSet
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Transform
from providers.embedding_cache import embed_cached
from providers.embeddings import EmbedderName, get_embedder

#: The single table every backend reads. Dense and FTS are two indexes over one
#: set of rows, not two stores — that is what makes hybrid fusion honest.
TABLE = "chunks"

#: The capability descriptor, spec §5.
DESCRIPTOR = "descriptor.json"

VECTOR_COLUMN = "vector"
TEXT_COLUMN = "text"


class LanceDbIndexConfig(BaseModel):
    #: The first real run downloads the model (Qwen3 is about 1.2 GB).
    embedder: EmbedderName = "qwen3-embedding-0.6b"

    #: Matryoshka truncation. `None` keeps the model's native width. Checked
    #: against the chosen embedder at run time: it must not exceed the native
    #: width, and a non-matryoshka embedder takes none at all.
    truncate_dim: int | None = None

    #: Recorded in the descriptor rather than baked into an index: with no ANN
    #: index built, the retriever chooses the distance type per search, and it
    #: must choose the one the index was declared with.
    metric: Literal["cosine", "l2"] = "cosine"

    #: On by default so `bm25` and `hybrid_rrf` cannot be mis-wired to an index
    #: that has no full-text side.
    build_fts: bool = True


@register
class LanceDbIndex(Transform[LanceDbIndexConfig]):
    name = "lancedb"
    version = "1"
    stage = Stage.INDEX
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)}
    output = ArtifactType.INDEX
    provides = {"backends": ["dense", "fts"]}
    config_model = LanceDbIndexConfig

    def fingerprint(self, config: LanceDbIndexConfig | None = None) -> str:
        """Model identity plus truncation width.

        Both must be in the recipe hash. The *name* of the embedder and
        `truncate_dim` are already hashed as config, but a model's **revision**
        is not — so without this, re-embedding the same corpus with a bumped
        revision would hit the cache and serve an index built from different
        vectors. A truncated index is likewise a different index, not a
        different view of one.

        `executor.run` passes the node's *validated* config, so a revision bump
        on a non-default embedder does move the artifact id. `config` stays
        optional — falling back to the default config — only for callers with no
        node in hand, such as the contract suite.
        """
        cfg = config or self.config_model()
        embedder = get_embedder(cfg.embedder)
        return f"{embedder.fingerprint()}|truncate_dim={cfg.truncate_dim}"

    def apply(
        self,
        inputs: Mapping[str, Any],
        config: LanceDbIndexConfig,
        ctx: RunContext,
    ) -> Callable[[Path], None]:
        # A variadic port hands over a list — this is corpus support. BM25's IDF
        # is degenerate on one document, so concatenation is not a convenience.
        chunks = [
            chunk
            for payload in inputs.get("chunks", [])
            for chunk in ChunkSet.model_validate(payload).chunks
        ]

        embedder = get_embedder(config.embedder)
        # Before any embedding, so a bad width fails with the reason and not
        # after a model download.
        embedder.check_dim(config.truncate_dim)
        dim = config.truncate_dim or embedder.native_dim
        # Through the cache at native width: a truncate_dim sweep embeds each
        # chunk once and slices the rest.
        vectors, stats = embed_cached(
            embedder,
            [chunk.text_to_embed for chunk in chunks],
            kind="document",
            dim=config.truncate_dim,
        )

        rows = [
            {
                "id": chunk.id,
                VECTOR_COLUMN: vector,
                # The retrievable projection: both the vector and the full-text
                # index are built from exactly this string, so dense and lexical
                # retrieval always agree about what a row says.
                TEXT_COLUMN: chunk.text_to_embed,
                "doc_id": chunk.doc_id,
                "ordinal": chunk.ordinal,
                # The canonical chunk, so a retriever can rebuild a `Hit.chunk`
                # with its original text, offsets and provenance.
                "chunk_json": json.dumps(
                    chunk.model_dump(mode="json"), ensure_ascii=False
                ),
            }
            for chunk, vector in zip(chunks, vectors)
        ]

        schema = pa.schema(
            [
                pa.field("id", pa.string()),
                # Fixed-size list, not a plain list: LanceDB needs the width to
                # be part of the schema to search the column at all.
                pa.field(VECTOR_COLUMN, pa.list_(pa.float32(), dim)),
                pa.field(TEXT_COLUMN, pa.string()),
                pa.field("doc_id", pa.string()),
                pa.field("ordinal", pa.int32()),
                pa.field("chunk_json", pa.string()),
            ]
        )

        descriptor = {
            "backends": ["dense"] + (["fts"] if config.build_fts else []),
            "native_dim": embedder.native_dim,
            "dim": dim,
            "metric": config.metric,
            # The registry name, which is what `get_embedder` resolves.
            "embedding_model": embedder.name,
            "embedding_revision": embedder.revision,
            "vector_kind": embedder.vector_kind,
            "doc_count": len(rows),
            "embeddings_computed": stats.computed,
            "embeddings_cached": stats.cached,
        }

        build_dir = ctx.output_dir / "lancedb"
        if build_dir.exists():
            shutil.rmtree(build_dir)
        _build(build_dir, rows, schema, descriptor, build_fts=config.build_fts)

        # The executor owns `Artifact.meta` and merges this under its own keys,
        # so it reaches the store and the UI. `descriptor.json` above remains
        # what a downstream transform actually reads.
        ctx.extras["meta"] = {"index_descriptor": descriptor}

        def write(dest: Path) -> None:
            # `dest` is the store's private scratch directory, already created.
            shutil.copytree(build_dir, dest, dirs_exist_ok=True)

        return write


def _build(
    directory: Path,
    rows: list[dict[str, Any]],
    schema: pa.Schema,
    descriptor: dict[str, Any],
    *,
    build_fts: bool,
) -> None:
    """Create the table and its indexes, then drop every handle.

    Nothing may still hold the database open when this returns: the store moves
    the committed directory into place, and an open LanceDB handle is exactly
    the thing that turns that move into a WinError 32.
    """
    directory.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(directory)

    # An empty corpus is a legal index, not an error — it is what an
    # unconfigured pipeline produces on its first run. `data=[]` gives LanceDB
    # no types to work from, so the schema-only form is used instead.
    table = (
        db.create_table(TABLE, data=rows, schema=schema)
        if rows
        else db.create_table(TABLE, schema=schema)
    )

    if build_fts:
        # The unified API. `create_fts_index(..., use_tantivy=False)` does the
        # same thing and is deprecated in 0.38.
        table.create_index(TEXT_COLUMN, config=FTS())

    # No ANN index: IVF_PQ needs far more rows than a bench corpus has, and
    # LanceDB brute-forces the vector column correctly without one. An HNSW
    # sweep is a Phase 3 concern and lands here as config, not as a new plugin.

    (directory / DESCRIPTOR).write_text(
        json.dumps(descriptor, ensure_ascii=False), encoding="utf-8"
    )

    del table, db
