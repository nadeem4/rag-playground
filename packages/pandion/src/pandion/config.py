"""Read a pipeline.yaml and check it before anything runs.

```yaml
plugins: [my_company.rag_steps]  # optional: modules to import, so their strategies can be named
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
answer:                     # optional: what p.ask runs after retrieval
  use: chat                 # search (the pieces as they are) or chat
  model: claude-haiku-4-5
```

Every key under a step other than `use` is a setting of that step, with the
same name as in its config model, so a file and the same pipeline built in the
RAG Playground hash to the same artifact ids. `store` takes any index
strategy. `embed` and `store` are one step when it runs: a store with an
`embedder` setting (such as lancedb) embeds while it writes, so `embed.use`
becomes that setting and `embed` is required; a store without one embeds by
itself, so `embed` is left out. A relative `path` or `models.cache_dir` is
read from the folder the file is in.

The question is not part of the file: it is passed to `p.retrieve` or `p.ask`,
which put it in the query step's `text`. A model's key is never in the file
either: it is passed to `p.retrieve` or `p.ask` as `credentials`.

The same pipeline can be written in code (`build`): each stage as a dict that
is the file's block for that stage, as a step class such as
`pandion.parse.Docling(do_ocr=False)` (`step_class`), or as a plain name, which
is short for `{"use": name}`. Every way goes through `from_dict`, so it is
checked the same way and gives the same `PipelineConfig`. `to_dict` turns a
`PipelineConfig` back into the file's shape.

Anything the file gets wrong is a `ConfigError` that names the step and what
it accepts.
"""

from __future__ import annotations

import importlib
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

import yaml
from pydantic import BaseModel, ValidationError

from pandion.embeddings import embedder_names
from pandion.models import ModelSettings
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import UnknownTransformError, registry
from pandion.stages import _strategy

TOP_KEYS = ("plugins", "path", "models", "index", "retrieve", "answer")
RETRIEVE_KEYS = ("rewrite", "search", "rerank")
INDEX_KEYS = ("source", "parse", "clean", "chunk", "embed", "store")
#: The source step when the file has none: the files given to index.run.
DEFAULT_SOURCE: tuple[str, dict[str, Any]] = ("upload", {})
#: Settings written under `embed` that the store receives with `embedder`.
EMBED_KEYS = ("truncate_dim",)

#: Where each stage's step sits in the file, for messages.
WHERE = {
    Stage.PARSE: "index.parse",
    Stage.CLEAN: "index.clean",
    Stage.CHUNK: "index.chunk",
    Stage.QUERY: "retrieve.rewrite",
    Stage.RETRIEVE: "retrieve.search",
    Stage.RERANK: "retrieve.rerank",
    Stage.USE_CASE: "answer",
}


class ConfigError(ValueError):
    """A pipeline file that cannot run, with what is wrong and where."""


@dataclass
class IndexConfig:
    """The index steps, each as (strategy name, its settings)."""

    parse: tuple[str, dict[str, Any]]
    chunk: tuple[str, dict[str, Any]]
    #: The store's settings, with `embedder` taken from `embed.use` when the
    #: store has that setting.
    store: dict[str, Any]
    clean: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    #: The index strategy that stores the pieces.
    store_use: str = "lancedb"
    #: Where each document comes from. `upload` reads the files given to
    #: index.run; another source is told each item as its `location` setting.
    source: tuple[str, dict[str, Any]] = DEFAULT_SOURCE


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
    #: The answer step, as (strategy name, its settings).
    answer: tuple[str, dict[str, Any]] | None = None
    #: Modules imported before the steps were checked, so their strategies exist.
    plugins: list[str] = field(default_factory=list)


def load(file: str | Path) -> PipelineConfig:
    """Read and check the pipeline file at `file`."""
    file = Path(file)
    data = yaml.safe_load(file.read_text(encoding="utf-8"))
    return from_dict(data, base=file.parent)


def from_dict(data: Any, *, base: Path) -> PipelineConfig:
    """Check a loaded pipeline file. Relative paths are read from `base`."""
    _keys(data, TOP_KEYS, "The pipeline file")
    plugins = _load_plugins(data.get("plugins"), base)
    if not data.get("path"):
        raise ConfigError(
            "The pipeline file has no path: the folder where Pandion keeps the "
            "sources, the artifacts and the embedding cache."
        )
    models = data.get("models") or {}
    if not isinstance(models, dict):
        raise ConfigError("models must be a mapping of settings.")
    models = dict(models)
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
    if "answer" in data and "retrieve" not in data:
        raise ConfigError(
            "The answer needs a retrieve section: the answer step reads what "
            "retrieval found."
        )
    config = PipelineConfig(
        path=_resolve(data["path"], base),
        models=settings,
        index=_index(data["index"]),
        retrieve=_retrieve(data["retrieve"]) if "retrieve" in data else None,
        answer=_answer(data["answer"]) if "answer" in data else None,
        plugins=plugins,
    )
    if config.retrieve is not None:
        _check_compatible(config)
    return config


def _check_compatible(config: PipelineConfig) -> None:
    """Build the retrieval graph for one placeholder document and validate it,
    so a retriever that cannot read the chosen store is refused now, not when
    it runs."""
    from pandion.graph import GraphValidationError
    from pandion.pipeline import IndexPipeline, RetrievalPipeline
    from pandion.sources import SourceFile

    index = IndexPipeline._of(config)
    if index._uploads():
        index.documents = {"placeholder": SourceFile(sha="0" * 64, filename="placeholder.pdf")}
    else:
        index.documents = {"placeholder": "placeholder"}
    graph, _ = RetrievalPipeline._of(config, index).graph("placeholder")
    try:
        graph.validate(registry)
    except GraphValidationError as exc:
        message = str(exc)
        if message.startswith("edge index->search.") and "requires" in message:
            search = config.retrieve.search[0]
            store = config.index.store_use
            needed = registry.get(Stage.RETRIEVE, search).requires.get("index", {})
            provided = registry.get(Stage.INDEX, store).provides
            raise ConfigError(
                f"retrieve.search uses '{search}', which needs a store with "
                f"{_capabilities(needed)}, but index.store uses '{store}', which has "
                f"{_capabilities(provided) or 'nothing in provides'}."
            ) from None
        raise ConfigError(message) from None


def _capabilities(claims: dict[str, Any]) -> str:
    """`{"backends": ["dense", "fts"], "format": ["lancedb"]}` as
    "backends dense, fts and format lancedb"."""
    parts = [
        f"{key} {', '.join(map(str, value)) if isinstance(value, list) else value}"
        for key, value in claims.items()
    ]
    return " and ".join(parts)


def build(
    *,
    path: str | Path,
    models: ModelSettings | dict[str, Any] | None = None,
    index: dict[str, Any],
    retrieve: dict[str, Any] | None = None,
    answer: Any = None,
    plugins: list[str] | None = None,
) -> PipelineConfig:
    """Check a pipeline written in code; relative paths are read from the
    current folder.

    Each stage is a dict (the file's block for that stage), a step class
    (`step_class`), a plain name for `{"use": name}`, or a list of these
    where the file takes a list. A stage that is None is left out.
    """
    if isinstance(models, BaseModel):
        models = models.model_dump(exclude_unset=True)
    data: dict[str, Any] = {"path": path, "models": models or {}}
    if plugins is not None:
        data["plugins"] = plugins
    data["index"] = {k: _block(v) for k, v in index.items() if v is not None}
    if isinstance(data["index"].get("clean"), dict):
        data["index"]["clean"] = [data["index"]["clean"]]
    if retrieve is not None and any(v is not None for v in retrieve.values()):
        data["retrieve"] = {k: _block(v) for k, v in retrieve.items() if v is not None}
    if answer is not None:
        data["answer"] = _block(answer)
    return from_dict(data, base=Path("."))


def _block(value: Any) -> Any:
    """One stage written in code, as the file's block for it."""
    if isinstance(value, str):
        return value if value == "none" else {"use": value}
    if isinstance(value, BaseModel) and isinstance(getattr(type(value), "use", None), str):
        return {"use": type(value).use, **value.model_dump(mode="json", exclude_unset=True)}
    if isinstance(value, (list, tuple)):
        return [_block(v) for v in value]
    return value


def to_dict(config: PipelineConfig) -> dict[str, Any]:
    """`config` in the file's shape: `from_dict` of it gives `config` again."""
    index = config.index
    store = dict(index.store)
    embed = None
    if "embedder" in store:
        embed = {"use": store.pop("embedder")}
        embed.update({key: store.pop(key) for key in EMBED_KEYS if key in store})
    data: dict[str, Any] = {}
    if config.plugins:
        data["plugins"] = list(config.plugins)
    data["path"] = config.path.as_posix()
    models = config.models.model_dump(mode="json", exclude_defaults=True)
    if models:
        data["models"] = models
    data["index"] = {}
    if index.source != DEFAULT_SOURCE:
        data["index"]["source"] = _out(index.source)
    data["index"]["parse"] = _out(index.parse)
    if index.clean:
        data["index"]["clean"] = [_out(step) for step in index.clean]
    data["index"]["chunk"] = _out(index.chunk)
    if embed is not None:
        data["index"]["embed"] = embed
    data["index"]["store"] = {"use": index.store_use, **store}
    if config.retrieve is not None:
        retrieve = config.retrieve
        data["retrieve"] = {}
        if retrieve.rewrite is not None:
            data["retrieve"]["rewrite"] = _out(retrieve.rewrite)
        data["retrieve"]["search"] = _out(retrieve.search)
        if retrieve.rerank:
            data["retrieve"]["rerank"] = [_out(step) for step in retrieve.rerank]
    if config.answer is not None:
        data["answer"] = _out(config.answer)
    return data


def _out(step: tuple[str, dict[str, Any]]) -> dict[str, Any]:
    use, settings = step
    return {"use": use, **settings}


def step_class(stage: Stage, use: str, module: str) -> type[BaseModel]:
    """A typed class for the `use` strategy of `stage`: its config model, which
    also knows its strategy's name, so a pipeline can take it in place of a dict.

    `Docling(do_ocr=False)` has the same fields and validation as the docling
    config model, keeps only the settings it was given (so it makes the same
    node as `{"use": "docling", "do_ocr": False}`), and refuses an unknown
    setting at once, naming the stage and listing the settings it has.
    """
    discover()
    strategy = registry.get(stage, use)
    model = strategy.config_model
    where = WHERE[stage]

    def __init__(self, **settings: Any) -> None:
        try:
            _strategy(stage, use, settings, where=where)
        except ValueError as exc:
            raise ConfigError(str(exc)) from None
        model.__init__(self, **settings)

    name = "".join(part.capitalize() for part in use.split("_"))
    return type(
        name,
        (model,),
        {
            "__init__": __init__,
            "__module__": module,
            "__qualname__": name,
            "__doc__": f"The {use} {stage} step. {strategy.summary}",
            "__annotations__": {"use": ClassVar[str]},
            "use": use,
        },
    )


def _load_plugins(plugins: Any, base: Path) -> list[str]:
    """Import each module under `plugins:`, so its @register calls run first.

    `base` (the folder the file is in) is searched too, the way a relative
    path is read from it; it is on sys.path only while the modules import.
    """
    if plugins is None:
        return []
    if not isinstance(plugins, list) or not all(isinstance(p, str) and p for p in plugins):
        raise ConfigError(
            "plugins must be a list of Python module names, for example "
            "plugins: [my_company.rag_steps]."
        )
    discover()  # built-ins first, so a clashing plugin fails at its own import
    folder = str(Path(base).resolve())
    added = folder not in sys.path
    if added:
        sys.path.insert(0, folder)
    try:
        for module in plugins:
            try:
                importlib.import_module(module)
            except Exception as exc:
                raise ConfigError(
                    f"plugins lists '{module}', which could not be imported: "
                    f"{type(exc).__name__}: {exc}"
                ) from None
    finally:
        if added:
            sys.path.remove(folder)
    return list(plugins)


def _answer(answer: Any) -> tuple[str, dict[str, Any]]:
    use, _ = _use(answer, "answer")
    if use == "eval":
        raise ConfigError(
            "answer uses 'eval', which scores retrieval rather than answering. "
            "Use pandion.evaluate for scoring."
        )
    discover()
    return _step(Stage.USE_CASE, answer, "answer")


def _index(index: Any) -> IndexConfig:
    _keys(index, INDEX_KEYS, "index")
    for stage in ("parse", "chunk", "store"):
        if stage not in index:
            raise ConfigError(
                f"The index has no {stage} step. An index needs parse, chunk "
                "and store, and embed when the store takes an embedder; clean "
                "may be left out."
            )
    discover()
    steps = index.get("clean") or []
    if not isinstance(steps, list):
        raise ConfigError("index.clean must be a list of cleaners, each with use.")
    store_use, store = _store(index.get("embed"), index["store"])
    return IndexConfig(
        parse=_step(Stage.PARSE, index["parse"], "index.parse"),
        clean=[
            _step(Stage.CLEAN, step, f"index.clean step {n}")
            for n, step in enumerate(steps, start=1)
        ],
        chunk=_step(Stage.CHUNK, index["chunk"], "index.chunk"),
        store=store,
        store_use=store_use,
        source=_source(index["source"]) if "source" in index else DEFAULT_SOURCE,
    )


def _source(step: Any) -> tuple[str, dict[str, Any]]:
    """The source step. Any source but upload is told which document to read."""
    use, settings = _step(Stage.SOURCE, step, "index.source")
    if use == "upload":
        if settings:
            raise ConfigError(
                "index.source uses 'upload', which takes no settings in a pipeline "
                "file: the files are the ones given to index.run."
            )
        return DEFAULT_SOURCE
    if "location" not in registry.get(Stage.SOURCE, use).config_model.model_fields:
        raise ConfigError(
            f"index.source uses '{use}', whose settings have no location field, "
            "so it cannot be told which document to read."
        )
    return use, settings


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
        # A KeyError's str() is its message in quotes; args[0] is the sentence.
        raise ConfigError(exc.args[0] if isinstance(exc, KeyError) else str(exc)) from None
    return use, settings


def _store(embed: Any, store: Any) -> tuple[str, dict[str, Any]]:
    """The store step, with the embedder merged in when the store takes one."""
    kind, store_settings = _use(store, "index.store")
    try:
        cls = registry.get(Stage.INDEX, kind)
    except UnknownTransformError:
        known = ", ".join(sorted(registry.all_for(Stage.INDEX)))
        raise ConfigError(
            f"index.store uses '{kind}', which is not a store. The stores are: {known}."
        ) from None
    takes_embedder = "embedder" in cls.config_model.model_fields
    if not takes_embedder:
        if embed is not None:
            raise ConfigError(
                f"index.store uses '{kind}', which embeds by itself, so index.embed must be left out."
            )
        settings = dict(store_settings)
    else:
        if embed is None:
            raise ConfigError(
                f"The index has no embed step. index.store uses '{kind}', which needs one: "
                "add embed: {use: <an embedder>}."
            )
        embedder, embed_settings = _use(embed, "index.embed")
        if embedder not in embedder_names():
            raise ConfigError(
                f"index.embed uses '{embedder}', which is not an embedder. "
                f"The embedders are: {', '.join(embedder_names())}."
            )
        _keys(embed_settings, EMBED_KEYS, "index.embed")
        misplaced = [key for key in store_settings if key == "embedder" or key in EMBED_KEYS]
        if misplaced:
            names = ", ".join(f"'{key}'" for key in misplaced)
            raise ConfigError(
                f"index.store sets {names}, which belongs under index.embed."
            )
        settings = {"embedder": embedder, **embed_settings, **store_settings}
    try:
        _strategy(Stage.INDEX, kind, settings, where="index.store")
    except ValueError as exc:
        raise ConfigError(str(exc)) from None
    return kind, settings


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
