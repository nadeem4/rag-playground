"""Read a pipeline.yaml and check it before anything runs.

```yaml
path: ./my-index            # where sources, artifacts and the embedding cache go
models:                     # optional: pandion.models.ModelSettings
  download: auto
index:
  parse: {use: docling, do_ocr: false}
  clean:                    # optional: a list of cleaners, run in order
    - use: dedupe_blocks
  chunk: {use: recursive_character, chunk_size: 400}
  embed: {use: qwen3-embedding-0.6b, truncate_dim: null}
  store: {use: lancedb, metric: cosine, build_fts: true}
retrieve:                   # optional: what p.retrieve runs
  rewrite: none             # optional: none, or {use: llm_rewrite, style: keywords}
  search: {use: hybrid_rrf, top_k: 20}
  rerank:                   # optional: none, one step, or a list run in order
    - use: cross_encoder
      top_k: 5
```

Every key under a step other than `use` is a setting of that step, with the
same name as in its config model, so a file and the same pipeline built in the
RAG Playground hash to the same artifact ids. `embed` and `store` are one step
when it runs: the lancedb index embeds while it writes, so `embed.use` becomes
its `embedder` setting. A relative `path` or `models.cache_dir` is read from
the folder the file is in.

The question is not part of the file: it is passed to `p.retrieve`, which
puts it in the query step's `text`. A model's key is never in the file either:
it is passed to `p.retrieve` as `credentials`.

Anything the file gets wrong is a `ConfigError` that names the step and what
it accepts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from pandion.embeddings import EMBEDDER_NAMES
from pandion.models import ModelSettings
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import UnknownTransformError
from pandion.stages import _strategy

TOP_KEYS = ("path", "models", "index", "retrieve")
RETRIEVE_KEYS = ("rewrite", "search", "rerank")
INDEX_KEYS = ("parse", "clean", "chunk", "embed", "store")
EMBED_KEYS = ("truncate_dim",)
STORE_KEYS = ("metric", "build_fts")


class ConfigError(ValueError):
    """A pipeline file that cannot run, with what is wrong and where."""


@dataclass
class IndexConfig:
    """The index steps, each as (strategy name, its settings)."""

    parse: tuple[str, dict[str, Any]]
    chunk: tuple[str, dict[str, Any]]
    #: The lancedb index's settings, with `embedder` taken from `embed.use`.
    store: dict[str, Any]
    clean: list[tuple[str, dict[str, Any]]] = field(default_factory=list)


@dataclass
class RetrieveConfig:
    """The retrieval steps. No rewrite means the question is searched as asked."""

    search: tuple[str, dict[str, Any]]
    rewrite: tuple[str, dict[str, Any]] | None = None
    rerank: list[tuple[str, dict[str, Any]]] = field(default_factory=list)


@dataclass
class PipelineConfig:
    path: Path
    models: ModelSettings
    index: IndexConfig
    retrieve: RetrieveConfig | None = None


def load(file: str | Path) -> PipelineConfig:
    """Read and check the pipeline file at `file`."""
    file = Path(file)
    data = yaml.safe_load(file.read_text(encoding="utf-8"))
    return from_dict(data, base=file.parent)


def from_dict(data: Any, *, base: Path) -> PipelineConfig:
    """Check a loaded pipeline file. Relative paths are read from `base`."""
    _keys(data, TOP_KEYS, "The pipeline file")
    if not data.get("path"):
        raise ConfigError(
            "The pipeline file has no path: the folder where Pandion keeps the "
            "sources, the artifacts and the embedding cache."
        )
    models = dict(data.get("models") or {})
    if models.get("cache_dir"):
        models["cache_dir"] = _resolve(models["cache_dir"], base)
    try:
        settings = ModelSettings(**models)
    except ValidationError as exc:
        problems = "; ".join(
            f"models.{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()
        )
        raise ConfigError(problems) from None
    if "index" not in data:
        raise ConfigError("The pipeline file has no index section.")
    return PipelineConfig(
        path=_resolve(data["path"], base),
        models=settings,
        index=_index(data["index"]),
        retrieve=_retrieve(data["retrieve"]) if "retrieve" in data else None,
    )


def _index(index: Any) -> IndexConfig:
    _keys(index, INDEX_KEYS, "index")
    for stage in ("parse", "chunk", "embed", "store"):
        if stage not in index:
            raise ConfigError(
                f"The index has no {stage} step. An index needs parse, chunk, "
                "embed and store; clean may be left out."
            )
    discover()
    steps = index.get("clean") or []
    if not isinstance(steps, list):
        raise ConfigError("index.clean must be a list of cleaners, each with use.")
    return IndexConfig(
        parse=_step(Stage.PARSE, index["parse"], "index.parse"),
        clean=[
            _step(Stage.CLEAN, step, f"index.clean step {n}")
            for n, step in enumerate(steps, start=1)
        ],
        chunk=_step(Stage.CHUNK, index["chunk"], "index.chunk"),
        store=_store(index["embed"], index["store"]),
    )


def _retrieve(retrieve: Any) -> RetrieveConfig:
    _keys(retrieve, RETRIEVE_KEYS, "retrieve")
    if not retrieve.get("search"):
        raise ConfigError(
            "retrieve has no search step. Retrieval needs search; rewrite and "
            "rerank may be left out."
        )
    discover()
    rewrite = retrieve.get("rewrite")
    if _none(rewrite):
        rewrite = None
    else:
        if isinstance(rewrite, dict) and "text" in rewrite:
            raise ConfigError(
                "retrieve.rewrite sets text, but the question is not part of the "
                "file: it is passed to p.retrieve."
            )
        rewrite = _step(Stage.QUERY, rewrite, "retrieve.rewrite")
    rerank = retrieve.get("rerank")
    steps = [] if _none(rerank) else rerank if isinstance(rerank, list) else [rerank]
    return RetrieveConfig(
        rewrite=rewrite,
        search=_step(Stage.RETRIEVE, retrieve["search"], "retrieve.search"),
        rerank=[
            _step(Stage.RERANK, step, "retrieve.rerank" if len(steps) == 1 else f"retrieve.rerank step {n}")
            for n, step in enumerate(steps, start=1)
        ],
    )


def _none(step: Any) -> bool:
    """Left out, or written as `none`."""
    return step is None or step == "none"


def _step(stage: Stage, step: Any, where: str) -> tuple[str, dict[str, Any]]:
    use, settings = _use(step, where)
    try:
        _strategy(stage, use, settings, where=where)
    except (UnknownTransformError, ValueError) as exc:
        raise ConfigError(str(exc)) from None
    return use, settings


def _store(embed: Any, store: Any) -> dict[str, Any]:
    embedder, embed_settings = _use(embed, "index.embed")
    kind, store_settings = _use(store, "index.store")
    if embedder not in EMBEDDER_NAMES:
        raise ConfigError(
            f"index.embed uses '{embedder}', which is not an embedder. "
            f"The embedders are: {', '.join(EMBEDDER_NAMES)}."
        )
    if kind != "lancedb":
        raise ConfigError(f"index.store uses '{kind}'. The only store is lancedb.")
    _keys(embed_settings, EMBED_KEYS, "index.embed")
    _keys(store_settings, STORE_KEYS, "index.store")
    settings = {"embedder": embedder, **embed_settings, **store_settings}
    try:
        _strategy(Stage.INDEX, "lancedb", settings, where="index.store")
    except ValueError as exc:
        raise ConfigError(str(exc)) from None
    return settings


def _use(step: Any, where: str) -> tuple[str, dict[str, Any]]:
    if not isinstance(step, dict) or not step.get("use"):
        raise ConfigError(f"{where} must say which strategy to use, as use: <name>.")
    settings = dict(step)
    return settings.pop("use"), settings


def _keys(data: Any, valid: tuple[str, ...], where: str) -> None:
    if not isinstance(data, dict):
        raise ConfigError(f"{where} must be a mapping of settings.")
    unknown = [key for key in data if key not in valid]
    if unknown:
        names = ", ".join(f"'{key}'" for key in unknown)
        raise ConfigError(f"{where} has no setting {names}. Its settings are: {', '.join(valid)}.")


def _resolve(value: Any, base: Path) -> Path:
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else base / path
