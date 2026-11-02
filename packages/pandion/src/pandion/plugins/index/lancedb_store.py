"""A LanceDB index: one collection, dense vectors and a full-text index side by side.

Three things here are load-bearing and easy to get subtly wrong.

*The artifact is a binding, not a database.* The rows are written into a
LanceDB store at the pipeline's index location (`<path>/index`), in a
collection named after the recipe and this artifact's id. The artifact itself
is a small JSON binding: the store, its settings, the collection and the
capability descriptor. Clearing the artifact store therefore never deletes
rows, and two document sets of one recipe get two collections side by side.

*The capability descriptor travels in the binding.* A downstream transform is
handed payloads only, never `Artifact.meta`, so meta alone could not tell a
retriever which embedder to query with. The binding's `descriptor` is the
channel that reaches the consumer, and it survives a cache hit for free. The
same dict is also published on `ctx.extras["meta"]`, which the executor folds
into `Artifact.meta` for the store and the UI.

*Vectors come from `chunk.text_to_embed`.* That is the contextual-retrieval
seam: an augmented text is retrieved on while the original is cited. The full
chunk travels alongside in the row so the citation stays exact.

LanceDB and pyarrow come with the `lancedb` extra and are imported inside
`apply()`, so discovering this plugin loads neither. Vectors go through the
embedding cache the run passes in `ctx.extras["embedding_cache"]`; a run with
none embeds every piece.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, ClassVar, Literal, Mapping

from pydantic import BaseModel, Field

from pandion.artifacts import ArtifactType
from pandion.embedding_cache import embed_cached
from pandion.embeddings import EmbedderName, embedder_names, get_embedder
from pandion.errors import require
from pandion.ids import AddedSettings
from pandion.index_lance import LanceSettings, LanceStore
from pandion.index_store import Binding, IndexMeta, IndexRow, IndexStore
from pandion.payloads import ChunkSet
from pandion.ports import PortSpec, RunContext, Stage
from pandion.registry import register
from pandion.transform import Explanation, Transform

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


class StoreIndexConfig(AddedSettings):
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


class LanceDbIndexConfig(StoreIndexConfig):
    pass


class StoreIndex(Transform[StoreIndexConfig]):
    """What every index step that builds through an `IndexStore` shares: chunk
    to rows, embed through the cache, write to a store, hand on a binding.

    A step differs in its name, config, extra, `provides` and in how it makes
    its store: `_require`, `_settings` and `_make_store`.
    """

    __abstract_transform__ = True

    #: 2 added the page_start, page_end and section columns that search
    #: filters read. 3 builds through the LanceDB index store (doc_version,
    #: roles, _pandion_meta). 4 makes the artifact a binding to a collection and
    #: keeps pages as a list. Every index rebuilds once, from cached embeddings.
    version = "4"
    stage = Stage.INDEX
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)}
    output = ArtifactType.INDEX

    def _require(self) -> None:
        """Import the store's library, or say which extra brings it."""
        raise NotImplementedError

    def _settings(self, config: StoreIndexConfig, ctx: RunContext) -> tuple[dict[str, Any], dict[str, Any]]:
        """(the settings to open the store now, the settings kept in the binding; never a secret)."""
        raise NotImplementedError

    def _make_store(self, settings: dict[str, Any]) -> IndexStore:
        raise NotImplementedError

    def explain(self, config: StoreIndexConfig) -> Explanation:
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

    def fingerprint(self, config: StoreIndexConfig | None = None) -> str:
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
        config: StoreIndexConfig,
        ctx: RunContext,
    ) -> dict[str, Any]:
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
        self._require()
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
                # What search filters read (pandion.filters). `pages` lists every
                # page the piece touches, as text; a piece with no pages has no
                # key, so it never matches a pages filter.
                metadata={
                    "ordinal": chunk.ordinal,
                    **(
                        {"pages": [str(n) for n in range(chunk.page_span[0], chunk.page_span[1] + 1)]}
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
            # The last page any piece touches: a pages filter lists pages up to it.
            "max_page": max((c.page_span[1] for c in chunks if c.page_span), default=0),
            "embeddings_computed": stats.computed,
            "embeddings_cached": stats.cached,
        }

        # Where the rows go. A pipeline sets the location, the recipe and this
        # artifact's id; a run without one (the contract suite) gets a private
        # folder and an anonymous name.
        recipe = ctx.extras.get("recipe_hash", "")
        name = f"{recipe[:16]}-{str(ctx.extras.get('artifact_id', ''))[:12]}"
        settings, kept = self._settings(config, ctx)
        _build(self._make_store(settings), name, rows, dim=dim, metric=config.metric, embedder=embedder, recipe=recipe)

        # The executor owns `Artifact.meta` and merges this under its own keys,
        # so it reaches the store and the UI. The binding's descriptor remains
        # what a downstream transform actually reads.
        ctx.extras["meta"] = {"index_descriptor": descriptor}

        return Binding(
            store=self.name, settings=kept, collection=name, recipe_hash=recipe, descriptor=descriptor
        ).model_dump(mode="json")


def _build(
    store: IndexStore,
    name: str,
    rows: list[IndexRow],
    *,
    dim: int,
    metric: str,
    embedder: Any,
    recipe: str,
) -> None:
    """Write the rows into a fresh collection of the LanceDB store.

    A collection of the same name (a forced run of an unchanged artifact) is
    replaced. Nothing may still hold the database open when this returns.
    """
    store.drop(name)
    # An empty corpus is a legal index, not an error: it is what an
    # unconfigured pipeline produces on its first run.
    collection = store.create(
        name,
        IndexMeta(
            embed_model=embedder.name, embed_revision=embedder.revision,
            dims=dim, metric=metric, recipe_hash=recipe,
        ),
    )
    collection.write_all(rows)

    # No ANN index: IVF_PQ needs far more rows than a bench corpus has, and
    # LanceDB brute-forces the vector column correctly without one. An HNSW
    # sweep is a Phase 3 concern and lands here as config, not as a new plugin.
    del collection, store


def _here(ctx: RunContext) -> str:
    """The pipeline's own index folder, or a private one for a run with none."""
    return str(ctx.extras.get("index_location") or ctx.output_dir / "index")


@register
class LanceDbIndex(StoreIndex):
    __abstract_transform__ = False
    name = "lancedb"
    extra = "lancedb"
    #: `format` says the index is rows in a store, which every built-in
    #: retriever reads; a step that keeps another format brings its own retriever.
    provides = {"backends": ["dense", "fts"], "format": ["store"]}
    config_model = LanceDbIndexConfig
    summary = (
        "Turns every piece into a vector (a list of numbers that captures its "
        "meaning) with an embedding model, and stores it in a LanceDB table with a "
        "keyword index over the same rows. Vector search and keyword search then "
        "read the same pieces, which is what lets hybrid search combine them fairly."
    )

    def _require(self) -> None:
        require("pyarrow", extra="lancedb", step="The lancedb index")

    def _settings(self, config: StoreIndexConfig, ctx: RunContext) -> tuple[dict[str, Any], dict[str, Any]]:
        settings = {"location": _here(ctx), "fts": config.build_fts}
        # The pipeline's own place is not kept in the binding (the artifact id
        # does not cover it, and the folder may move); whoever opens it says.
        kept = {"fts": config.build_fts} if ctx.extras.get("index_location") else settings
        return settings, kept

    def _make_store(self, settings: dict[str, Any]) -> IndexStore:
        return LanceStore(LanceSettings(**settings))
