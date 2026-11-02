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

LanceDB and pyarrow come with the `lancedb` extra and are imported inside
`apply()`, so discovering this plugin loads neither. Vectors go through the
embedding cache the run passes in `ctx.extras["embedding_cache"]`; a run with
none embeds every piece.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Callable, ClassVar, Literal, Mapping

from pydantic import BaseModel, Field

from pandion.artifacts import ArtifactType
from pandion.embedding_cache import embed_cached
from pandion.embeddings import EmbedderName, embedder_names, get_embedder
from pandion.errors import require
from pandion.ids import AddedSettings
from pandion.index_lance import LanceSettings, LanceStore
from pandion.index_store import IndexMeta, IndexRow
from pandion.payloads import ChunkSet
from pandion.ports import PortSpec, RunContext, Stage
from pandion.registry import register
from pandion.transform import Explanation, Transform

#: The single table every backend reads. Dense and FTS are two indexes over one
#: set of rows, not two stores — that is what makes hybrid fusion honest.
TABLE = "chunks"

#: The capability descriptor, spec §5.
DESCRIPTOR = "descriptor.json"

VECTOR_COLUMN = "vector"
TEXT_COLUMN = "text"


#: The settings form's names for the built-in embedders. An added embedder is
#: shown by its own name.
_EMBEDDER_LABELS = {
    "bge-small-en-v1.5": "BGE small, English",
    "fake-deterministic": "Fake, for tests",
    "qwen3-embedding-0.6b": "Qwen3 Embedding 0.6B",
}


def _embedder_labels(schema: dict[str, Any]) -> None:
    """Label every registered embedder, so each choice in the form has a name."""
    schema["x-labels"] = {name: _EMBEDDER_LABELS.get(name, name) for name in sorted(embedder_names())}


class LanceDbIndexConfig(AddedSettings):
    #: Left out of the artifact id while empty, so an index with no `access:` block keeps its id.
    added: ClassVar[tuple[str, ...]] = ("doc_roles",)

    #: The first real run downloads the model (Qwen3 is about 1.2 GB).
    embedder: EmbedderName = Field(
        default="qwen3-embedding-0.6b",
        title="Embedding model",
        json_schema_extra=_embedder_labels,
        description=(
            "The model that turns each piece into a vector. The first run "
            "downloads it."
        ),
    )

    #: Matryoshka truncation. `None` keeps the model's native width. Checked
    #: against the chosen embedder at run time: it must not exceed the native
    #: width, and a non-matryoshka embedder takes none at all.
    truncate_dim: int | None = Field(
        default=None,
        title="Shorter vectors",
        description=(
            "Keep only the first this many numbers of each vector, to save "
            "space. Only some models allow it. Empty keeps the full length."
        ),
    )

    #: Recorded in the descriptor rather than baked into an index: with no ANN
    #: index built, the retriever chooses the distance type per search, and it
    #: must choose the one the index was declared with.
    metric: Literal["cosine", "l2"] = Field(
        default="cosine",
        title="Distance",
        json_schema_extra={
            "x-labels": {
                "cosine": "Cosine: the angle between vectors",
                "l2": "L2: the straight-line distance",
            }
        },
        description=(
            "How closeness between vectors is measured: cosine compares their "
            "direction, l2 their straight-line distance."
        ),
    )

    #: Roles by file hash, filled in by the pipeline when it has an `access:`
    #: block. Not a setting to edit, so a form leaves it out.
    doc_roles: dict[str, list[str]] | None = Field(default=None, json_schema_extra={"readOnly": True})

    #: On by default so `bm25` and `hybrid_rrf` cannot be mis-wired to an index
    #: that has no full-text side.
    build_fts: bool = Field(
        default=True,
        title="Keyword index",
        description=(
            "Also build a keyword index, so keyword and hybrid search can run. "
            "Leave it on."
        ),
    )


@register
class LanceDbIndex(Transform[LanceDbIndexConfig]):
    name = "lancedb"
    extra = "lancedb"
    #: 2 added the page_start, page_end and section columns that search
    #: filters read. 3 builds through the LanceDB index store (doc_version,
    #: roles, _pandion_meta). Every index rebuilds once, from cached embeddings.
    version = "3"
    stage = Stage.INDEX
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)}
    output = ArtifactType.INDEX
    #: `format` says the index is a LanceDB table, which every built-in
    #: retriever opens; a store in another format brings its own retriever.
    provides = {"backends": ["dense", "fts"], "format": ["lancedb"]}
    config_model = LanceDbIndexConfig
    summary = (
        "Turns every piece into a vector (a list of numbers that captures its "
        "meaning) with an embedding model, and stores it in a LanceDB table with a "
        "keyword index over the same rows. Vector search and keyword search then "
        "read the same pieces, which is what lets hybrid search combine them fairly."
    )

    def explain(self, config: LanceDbIndexConfig) -> Explanation:
        # `get_embedder` only builds the provider object; no model is loaded.
        embedder = get_embedder(config.embedder)
        name, native, dim = embedder.name, embedder.native_dim, config.truncate_dim
        if embedder.supports_matryoshka:
            kind = (
                "a model trained so that the first part of a vector still works "
                "on its own (Matryoshka)"
            )
        else:
            kind = "a model not trained to have its vectors cut shorter"
        kept = "all are kept" if dim is None else (
            f"each is cut to its first {dim} and rescaled to length 1"
        )
        fts = (
            " A keyword index is built too, for bm25 and hybrid_rrf."
            if config.build_fts
            else ""
        )
        settings = (
            f"Embeds with {name}, {kind}. Its vectors have {native} numbers and "
            f"{kept}; they are cached at full width, so trying another size later "
            f"reuses them instead of embedding again.{fts}"
        )
        metric = (
            f"Vectors are compared by {config.metric} distance; since every vector "
            "has length 1, cosine and l2 put hits in the same order."
        )

        if name == "qwen3-embedding-0.6b":
            model = "The first run downloads the model, about 1.2 GB."
        elif name == "bge-small-en-v1.5":
            model = (
                "A small, fast model that downloads quickly, but it usually "
                "matches less well than qwen3-embedding-0.6b."
            )
        else:
            model = (
                "A stand-in for tests: it matches texts that share words, not "
                "meaning, and needs no download."
            )
        if dim is None:
            size = (
                "Full width gives the best matches; a smaller truncate_dim makes a "
                "smaller, faster index, usually for a small loss in quality."
                if embedder.supports_matryoshka
                else "Full width is the only choice for this model."
            )
        else:
            size = (
                f"Keeping {dim} of {native} numbers makes the index about "
                f"{dim / native:.0%} of full size and search faster, usually for a "
                "small loss in match quality."
            )
        tradeoff = f"{model} {size} {metric}"

        # The same conditions `embedder.check_dim` raises on at run time.
        warning = None
        if dim is not None:
            if not embedder.supports_matryoshka:
                warning = (
                    f"{name} was not trained for Matryoshka truncation, so "
                    "truncate_dim must be left empty: cutting its vectors would "
                    "throw information away."
                )
            elif dim <= 0:
                warning = "truncate_dim must be a positive number of dimensions."
            elif dim > native:
                warning = (
                    f"{name} makes vectors of {native} numbers, and truncation "
                    f"can only shrink them. Pick {native} or less."
                )
        if warning is not None:
            return Explanation(
                settings=settings, tradeoff=tradeoff, warning=warning, blocking=True
            )
        if not config.build_fts:
            warning = (
                "No keyword index is built, so bm25 and hybrid_rrf will fail on "
                "this index. Use dense retrieval, or turn build_fts back on."
            )
        return Explanation(settings=settings, tradeoff=tradeoff, warning=warning)

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

        embedder = get_embedder(config.embedder, ctx.extras.get("models"))
        # Before any embedding, so a bad width fails with the reason and not
        # after a model download.
        embedder.check_dim(config.truncate_dim)
        require("pyarrow", extra="lancedb", step="The lancedb index")
        dim = config.truncate_dim or embedder.native_dim
        # Through the cache at native width: a truncate_dim sweep embeds each
        # chunk once and slices the rest.
        vectors, stats = embed_cached(
            embedder,
            [chunk.text_to_embed for chunk in chunks],
            kind="document",
            dim=config.truncate_dim,
            cache=ctx.extras.get("embedding_cache"),
        )

        by_doc: dict[str, list[str]] = {}
        for chunk in chunks:
            by_doc.setdefault(chunk.doc_id, []).append(chunk.id)
        versions = {
            doc: hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest()[:16]
            for doc, ids in by_doc.items()
        }

        rows = [
            IndexRow(
                id=chunk.id,
                doc_id=chunk.doc_id,
                doc_version=versions[chunk.doc_id],
                # The retrievable projection: both the vector and the full-text
                # index are built from exactly this string, so dense and lexical
                # retrieval always agree about what a row says.
                text=chunk.text_to_embed,
                vector=vector,
                roles=(config.doc_roles or {}).get(chunk.doc_id, []),
                # What search filters read (pandion.filters). A piece with no
                # pages has no page keys, so it never matches a pages filter.
                metadata={
                    "ordinal": chunk.ordinal,
                    **(
                        {"page_start": chunk.page_span[0], "page_end": chunk.page_span[1]}
                        if chunk.page_span
                        else {}
                    ),
                    "section": list(chunk.heading_path),
                },
                # The canonical chunk, so a retriever can rebuild a `Hit.chunk`
                # with its original text, offsets and provenance.
                chunk=json.dumps(chunk.model_dump(mode="json"), ensure_ascii=False),
            )
            for chunk, vector in zip(chunks, vectors)
        ]

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
            # How many pieces sit under a heading. 0 means a section filter
            # can match nothing, which the retriever reports as an error.
            "sections": sum(1 for chunk in chunks if chunk.heading_path),
            "embeddings_computed": stats.computed,
            "embeddings_cached": stats.cached,
        }

        build_dir = ctx.output_dir / "lancedb"
        if build_dir.exists():
            shutil.rmtree(build_dir)
        _build(build_dir, rows, descriptor, dim=dim, metric=config.metric, embedder=embedder, build_fts=config.build_fts)

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
    rows: list[IndexRow],
    descriptor: dict[str, Any],
    *,
    dim: int,
    metric: str,
    embedder: Any,
    build_fts: bool,
) -> None:
    """Write the rows through the LanceDB store, then drop every handle.

    Nothing may still hold the database open when this returns: the store moves
    the committed directory into place, and an open LanceDB handle is exactly
    the thing that turns that move into a WinError 32.
    """
    directory.mkdir(parents=True, exist_ok=True)
    store = LanceStore(LanceSettings(location=str(directory), fts=build_fts))
    # An empty corpus is a legal index, not an error: it is what an
    # unconfigured pipeline produces on its first run.
    collection = store.create(
        TABLE,
        IndexMeta(
            embed_model=embedder.name, embed_revision=embedder.revision,
            dims=dim, metric=metric, recipe_hash="",  # T9 fills the recipe hash in
        ),
    )
    collection.write_all(rows)

    # No ANN index: IVF_PQ needs far more rows than a bench corpus has, and
    # LanceDB brute-forces the vector column correctly without one. An HNSW
    # sweep is a Phase 3 concern and lands here as config, not as a new plugin.

    (directory / DESCRIPTOR).write_text(
        json.dumps(descriptor, ensure_ascii=False), encoding="utf-8"
    )

    del collection, store
