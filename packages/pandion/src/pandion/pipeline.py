"""A pipeline in three parts, run through the executor and the store.

```python
from pandion import Pipeline

p = Pipeline.from_yaml("pipeline.yaml")
report = p.index.run("docs/")
report.documents["guides/chunking.pdf"].stages["parse"].output   # a ParsedDoc
report.index.output                                              # the index folder
report = p.index.run("docs/", through="chunk")   # stop after chunking; report.index is None

report = p.index.sync("docs/")      # later, after files were added, changed or removed
report.added, report.changed, report.removed, report.unchanged

result = p.retrieve("How big should a chunk be?", k=5)
result.hits                         # the hits, best first
result.stages["search"].output      # what the search step found, before reranking

answer = p.ask("How big should a chunk be?")
answer.text                         # the answer, or the pieces found
answer.stages["answer"].output      # the answer step's Output
```

The three parts are `IndexPipeline` (parse, clean, chunk, embed, store),
`RetrievalPipeline` (rewrite, search, rerank) and `QueryPipeline` (the answer
step). Each can be built on its own, from a file (`from_yaml`) or in code, with
each stage as a dict, a step class or a name (see `pandion.config`). Every way
gives the same `PipelineConfig`, so the same graph and the same artifact ids.
`to_yaml()` writes any of them back as a file.

Every step is cached by its recipe hash, so running the same files with the
same config again only reads what is stored. Under the config's `path` Pandion
keeps `sources/` (each file once, by its fingerprint), `artifacts/` (the store),
`embeddings/` (the embedding cache) and, after a sync, `manifest.json` (see
`pandion.manifest`).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from typing import Any, Callable

import yaml

from pandion.config import CategoryConfig, ConfigError, PipelineConfig, build, from_dict as _from_dict, load, to_dict
from pandion.cost import cost as _cost
from pandion.embedding_cache import EmbeddingCache
from pandion.executor import NodeResult, RunResult, run
from pandion.fetch import fetch_url, is_url
from pandion.filters import check_where, resolve as _resolve_where
from pandion.docinfo import DocumentInfo, document_info
from pandion.formats import check_contents, check_readable, format_of
from pandion.graph import Edge, Graph, Node
from pandion.manifest import MANIFEST, Manifest, recipe_hash
from pandion.payloads import ChunkSet, Hit, Output, ParsedDoc, Query, RetrievalResult
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry
from pandion.results import ResultStore, StageResult
from pandion.routing import Sorting, sort_document
from pandion.sources import SourceFile, Sources
from pandion.storage import Store

#: How each stored payload is handed back in a `StageResult`.
_OUTPUTS = {
    Stage.PARSE: ParsedDoc,
    Stage.CLEAN: ParsedDoc,
    Stage.CHUNK: ChunkSet,
    Stage.ENRICH: ChunkSet,
    Stage.QUERY: Query,
    Stage.RETRIEVE: RetrievalResult,
    Stage.RERANK: RetrievalResult,
    Stage.USE_CASE: Output,
}

#: Settings a stage may take: a dict (the file's block), a step class, a name.
Step = Any

#: The largest page a URL document may be, in bytes.
URL_MAX_BYTES = 20 * 1024 * 1024

#: What index.run, retrieve and ask take as documents: a file, a folder, a
#: list of both, or a mapping of document id to file.
Documents = Any

#: The callback a run reports each event to (see IndexPipeline.execute).
OnEvent = Callable[[dict[str, Any]], None]

#: Events that list several node ids, and the field that names their steps.
_NAMED_LISTS = (("nodes", "steps"), ("selected", "selected_steps"), ("skipped", "skipped_steps"))

@dataclass(frozen=True)
class DocumentEntry:
    """One document in the manifest: where it went, why, and its labels."""

    id: str
    filename: str
    category: str
    reason: str
    metadata: dict[str, str]
    content_hash: str


@dataclass
class DocumentReport:
    """What each step did to one document, keyed source, parse, clean.1 ...,
    chunk, and enrich when the index has one."""

    stages: dict[str, StageResult] = field(default_factory=dict)
    #: The category whose steps this document went through.
    category: str = "default"
    #: Why the document went to that category, in plain words.
    reason: str = ""


@dataclass
class IndexReport:
    """One index run: each document's steps, and the index built from them all.

    `index` is None when the run stopped before it (`through`). A step stopped
    by `cancel` is reported with status "skipped".
    """

    documents: dict[str, DocumentReport]
    index: StageResult | None

    def _steps(self) -> list[StageResult]:
        steps = [s for d in self.documents.values() for s in d.stages.values()]
        if self.index is not None:
            steps.append(self.index)
        return steps

    @property
    def ok(self) -> bool:
        """Every step that was asked for ran or came from the cache."""
        return all(s.status in ("executed", "cached") for s in self._steps())

    def cost(
        self,
        prices: dict[str, tuple[float, float]] | None = None,
        *,
        since: str | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """Seconds, tokens, estimated dollars and the cache share of this
        run's steps; see `pandion.cost.cost`. `prices` replaces
        `pandion.llm.PRICES`: {model id: (dollars per million input tokens,
        per million output tokens)}. `since` and `before` keep part of the
        run, in pipeline order (see `pandion.cost.cost`)."""
        return _cost(self._costed(), prices, since=since, before=before)

    def _costed(self) -> list[StageResult]:
        """Every step that `cost()` counts."""
        return self._steps()


@dataclass
class SyncReport(IndexReport):
    """One sync: the index run, and which document ids it added, changed,
    removed or left unchanged since the last sync."""

    added: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    #: The index settings differ from the last sync's.
    config_changed: bool = False


@dataclass
class Retrieval:
    """One question searched: the hits, and what each step did.

    `stages` holds "rewrite" (the query step, `text` when the file has no
    rewrite), "search", and "rerank", a list with one entry per reranker in
    order. `index` is the index step the search read. A step that fails is
    reported, not raised; the steps after it are skipped and `hits` is empty.
    `upstream` holds the document steps (source, parse, clean, chunk) that
    ran or came from the cache on the way to the index, without their
    outputs. It is only read by `cost()`.
    """

    stages: dict[str, Any]
    index: StageResult
    upstream: list[StageResult] = field(default_factory=list, repr=False)

    def _steps(self) -> list[StageResult]:
        return [self.index, self.stages["rewrite"], self.stages["search"], *self.stages["rerank"]]

    def _costed(self) -> list[StageResult]:
        """Every step that `cost()` counts: the report's own and the upstream ones."""
        return [*self.upstream, *self._steps()]

    @property
    def ok(self) -> bool:
        return all(s.status in ("executed", "cached") for s in self._steps())

    def cost(
        self,
        prices: dict[str, tuple[float, float]] | None = None,
        *,
        since: str | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """Seconds, tokens, estimated dollars and the cache share of this
        run's steps; see `pandion.cost.cost`. `prices` replaces
        `pandion.llm.PRICES`: {model id: (dollars per million input tokens,
        per million output tokens)}. `since` and `before` keep part of the
        run, in pipeline order (see `pandion.cost.cost`)."""
        return _cost(self._costed(), prices, since=since, before=before)

    @property
    def result(self) -> RetrievalResult | None:
        """The last step's output: the last reranker's, or the search's."""
        return self._steps()[-1].output if self.ok else None

    @property
    def hits(self) -> list[Hit]:
        return self.result.hits if self.result is not None else []


@dataclass
class Answer:
    """One question answered: what retrieval found, and what the answer step made.

    `stages` holds the retrieval's steps ("rewrite", "search", "rerank") and
    "answer". `output` is the answer step's `Output`: kind "search" with the
    found pieces, or kind "chat" with the answer, its citations and counts.
    A step that fails is reported, not raised, and `output` is then None.
    """

    retrieval: Retrieval
    answer: StageResult

    @property
    def stages(self) -> dict[str, Any]:
        return {**self.retrieval.stages, "answer": self.answer}

    @property
    def index(self) -> StageResult:
        return self.retrieval.index

    @property
    def ok(self) -> bool:
        return self.retrieval.ok and self.answer.status in ("executed", "cached")

    def cost(
        self,
        prices: dict[str, tuple[float, float]] | None = None,
        *,
        since: str | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """Seconds, tokens, estimated dollars and the cache share of this
        run's steps; see `pandion.cost.cost`. `prices` replaces
        `pandion.llm.PRICES`: {model id: (dollars per million input tokens,
        per million output tokens)}. `since` and `before` keep part of the
        run, in pipeline order (see `pandion.cost.cost`)."""
        return _cost(self._costed(), prices, since=since, before=before)

    def _costed(self) -> list[StageResult]:
        """Every step that `cost()` counts: the retrieval's and the answer step."""
        return [*self.retrieval._costed(), self.answer]

    @property
    def hits(self) -> list[Hit]:
        return self.retrieval.hits

    @property
    def output(self) -> Output | None:
        return self.answer.output if self.ok else None

    @property
    def text(self) -> str:
        """The answer step's `text` when it gives one, else the chat answer as
        one text, or the found pieces one after another."""
        if self.output is None:
            return ""
        payload = self.output.payload
        if isinstance(payload.get("text"), str) and payload["text"]:
            return payload["text"]
        if self.output.kind == "chat":
            return "".join(segment["text"] for segment in payload["answer"])
        return "\n\n".join(row["snippet"] for row in payload["results"])


#: Steps that call a chat model, by stage; their extra depends on the model's provider.
CHAT_STEPS = {
    "llm_context": "enrich",
    "llm_rewrite": "query",
    "llm_rerank": "rerank",
    "chat": "use_case",
}


def extras_for(config: PipelineConfig) -> list[str]:
    """The extras the pipeline's steps need, sorted.

    Each strategy and embedder names its own extra (`extra = "..."`); one
    that names none needs only the base install.
    """
    from pandion.embeddings import get_embedder
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry

    discover()
    index = config.index
    steps = [("index.source", Stage.SOURCE, index.source)]
    for name, category in index.categories.items():
        where = "index" if index.legacy else f"categories.{name}"
        steps.append((f"{where}.parse", Stage.PARSE, category.parse))
        steps.extend((f"{where}.clean", Stage.CLEAN, step) for step in category.clean)
        steps.append((f"{where}.chunk", Stage.CHUNK, category.chunk))
    if index.enrich:
        steps.append(("index.enrich", Stage.ENRICH, index.enrich))
    steps.append(("index.store", Stage.INDEX, (index.store_use, index.store)))
    if config.retrieve is not None:
        retrieve = config.retrieve
        if retrieve.rewrite:
            steps.append(("retrieve.rewrite", Stage.QUERY, retrieve.rewrite))
        steps.append(("retrieve.search", Stage.RETRIEVE, retrieve.search))
        steps.extend(("retrieve.rerank", Stage.RERANK, step) for step in retrieve.rerank)
        if config.answer is not None:
            steps.append(("answer", Stage.USE_CASE, config.answer))

    extras = set()
    for key, stage, (use, settings) in steps:
        if stage != Stage.INDEX and use in CHAT_STEPS:
            extras.add(_chat_extra(use, settings))
            continue
        try:
            extras.add(registry.get(stage, use).extra)
        except KeyError:
            raise ConfigError(
                f"{key} uses '{use}', which is not registered, so its extra is unknown."
            ) from None
    if index.store.get("embedder") is not None:
        extras.add(get_embedder(index.store["embedder"]).extra)
    extras.discard("")
    return sorted(extras)


def _chat_extra(use: str, settings: dict) -> str:
    """Claude models need the Anthropic SDK; every other model the OpenAI SDK."""
    from pandion.llm import CHAT_MODELS
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry

    discover()
    model = registry.get(Stage(CHAT_STEPS[use]), use).config_model(**settings).model
    return "anthropic" if CHAT_MODELS[model].provider == "anthropic" else "openai"


class Pipeline:
    """All three parts: the index, the retrieval and the answer step.

    Build one from a file with `from_yaml`, or in code with a keyword per stage:

        Pipeline(path="./my-index", parse=Docling(do_ocr=False),
                 chunk={"use": "recursive_character", "chunk_size": 400},
                 embed="qwen3-embedding-0.6b", store="lancedb",
                 search=HybridRrf(top_k=20), rerank=[CrossEncoder(top_k=5)],
                 answer="search")

    Each stage is a dict (the file's block for it), a step class or a name.
    For documents that need different steps, give `categories` and `route`
    (the file's blocks) in place of `parse`, `clean` and `chunk`.
    `source` is optional, as in the file: left out, the documents are the
    files given to index.run (see "Your own source" in docs/pandion.md).
    `embed` is left out for a store that embeds by itself.
    `retrieval` is None without a search step and `query` is None without an
    answer step.
    """

    def __init__(
        self,
        *,
        path: str | Path,
        store: Step,
        parse: Step = None,
        chunk: Step = None,
        categories: dict | None = None,
        route: list | None = None,
        embed: Step = None,
        clean: Step = None,
        source: Step = None,
        enrich: Step = None,
        rewrite: Step = None,
        search: Step = None,
        rerank: Step = None,
        answer: Step = None,
        models: Any = None,
    ) -> None:
        self._setup(
            build(
                path=path,
                models=models,
                index={
                    "source": source, "parse": parse, "clean": clean,
                    "chunk": chunk, "enrich": enrich, "embed": embed, "store": store,
                },
                categories=categories,
                route=route,
                retrieve={"rewrite": rewrite, "search": search, "rerank": rerank},
                answer=answer,
            )
        )

    def documents(self) -> list[DocumentEntry]:
        """The documents the last sync, add or move saved, with the category
        and reason of each, sorted by id. Empty before the first one."""
        return self.index.listed()

    def _setup(self, config: PipelineConfig) -> None:
        self.config = config
        self.index = IndexPipeline._of(config)
        self.retrieval = RetrievalPipeline._of(config, self.index) if config.retrieve else None
        self.query = QueryPipeline._of(config, self.retrieval) if config.answer else None

    @classmethod
    def _of(cls, config: PipelineConfig) -> Pipeline:
        pipeline = cls.__new__(cls)
        pipeline._setup(config)
        return pipeline

    @classmethod
    def from_yaml(cls, file: str | Path) -> Pipeline:
        """Read and check `file` (see `pandion.config`); nothing runs yet."""
        return cls._of(load(file))

    #: The name this had before the other ways to build a pipeline.
    from_file = from_yaml

    def to_yaml(self, file: str | Path | None = None) -> str:
        """The pipeline as a file (see `pandion.config`), also written to `file` if given."""
        return _write(self.config, file)

    @classmethod
    def from_dict(cls, data: dict[str, Any], *, base: str | Path = ".") -> Pipeline:
        """The pipeline file's content as a dict, for an app that keeps
        pipelines as JSON. Checked exactly as a file is; a relative `path` or
        `models.cache_dir` is read from `base`."""
        return cls._of(_from_dict(data, base=Path(base)))

    def extras(self) -> list[str]:
        """The extras this pipeline's steps need, sorted, as in
        `pip install "pandion[...]"`. A step that names none needs only the base install."""
        return extras_for(self.config)

    def to_dict(self) -> dict[str, Any]:
        """The pipeline in the file's shape, as plain data: `from_dict` of it
        gives this pipeline again."""
        return to_dict(self.config)

    def result(self, artifact_id: str) -> Any:
        """A stored result by its id (a `StageResult.artifact_id`), as stored:
        a dict for every result but an index, whose result is its folder.

        The id is checked before any path is built from it, so an app may pass
        one it was sent.
        """
        return ResultStore(self.config.path).get(artifact_id)

    def retrieve(
        self,
        question: str,
        k: int | None = None,
        *,
        documents: Documents = None,
        where: dict[str, Any] | None = None,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        force: bool = False,
    ) -> Retrieval:
        """Search the index for `question`. See `RetrievalPipeline.retrieve`."""
        if self.retrieval is None:
            raise ValueError(
                "The pipeline has no retrieve section, so there is nothing to "
                "search with. Add a retrieve section with at least a search step."
            )
        return self.retrieval.retrieve(
            question, k, documents=documents, where=where, credentials=credentials,
            on_event=on_event, cancel=cancel, force=force,
        )

    def ask(
        self,
        question: str,
        k: int | None = None,
        *,
        documents: Documents = None,
        where: dict[str, Any] | None = None,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        force: bool = False,
    ) -> Answer:
        """Answer `question`. See `QueryPipeline.ask`."""
        if self.query is None:
            raise ValueError(
                "The pipeline has no answer section, so there is nothing to answer "
                "with. Add answer: with any answer strategy, for example search or chat."
            )
        return self.query.ask(
            question, k, documents=documents, where=where, credentials=credentials,
            on_event=on_event, cancel=cancel, force=force,
        )


class IndexPipeline:
    """Parse, clean, chunk, embed and store, for many documents into one index.

    In code: `IndexPipeline(path=..., parse=..., chunk=..., embed=..., store=...)`,
    with `source`, `clean` (one cleaner or a list) and `models` optional, and
    `embed` left out for a store that embeds by itself. In place of `parse`,
    `clean` and `chunk`, give `categories` and `route` (the file's blocks):
    each document then goes through the steps of its category.
    """

    def __init__(
        self,
        *,
        path: str | Path,
        store: Step,
        parse: Step = None,
        chunk: Step = None,
        categories: dict | None = None,
        route: list | None = None,
        embed: Step = None,
        clean: Step = None,
        source: Step = None,
        enrich: Step = None,
        models: Any = None,
    ) -> None:
        self._setup(
            build(
                path=path,
                models=models,
                index={
                    "source": source, "parse": parse, "clean": clean,
                    "chunk": chunk, "enrich": enrich, "embed": embed, "store": store,
                },
                categories=categories,
                route=route,
            )
        )

    @classmethod
    def _of(cls, config: PipelineConfig) -> IndexPipeline:
        part = cls.__new__(cls)
        part._setup(config)
        return part

    @classmethod
    def from_yaml(cls, file: str | Path) -> IndexPipeline:
        """The index part of the pipeline file at `file`."""
        return Pipeline.from_yaml(file).index

    def to_yaml(self, file: str | Path | None = None) -> str:
        """The index part as a file, also written to `file` if given."""
        return _write(self.config, file)

    def _setup(self, config: PipelineConfig) -> None:
        self.config = replace(config, retrieve=None, answer=None)
        root = config.path
        self.sources = Sources(root / "sources")
        self.store = Store(root / "artifacts")
        self.embedding_cache = EmbeddingCache(root / "embeddings")
        #: The documents the last run or sync in this process indexed: stored
        #: files with the upload source, locations with any other.
        self.documents: dict[str, SourceFile | str] | None = None
        #: Categories chosen by hand, by document id (see `assign`).
        self._pins: dict[str, str] = {}
        #: The category each document had in the last run or sync.
        self._categories: dict[str, str] | None = None
        #: The same, with the reason for each.
        self._sortings: dict[str, Sorting] = {}
        #: Labels by document id, read by the route's metadata check (see `assign`).
        self._labels: dict[str, dict[str, str]] = {}

    def assign(
        self,
        *,
        categories: dict[str, str] | None = None,
        metadata: dict[str, dict[str, str]] | None = None,
    ) -> None:
        """Send documents to categories by hand, by document id. The choice
        holds for this object and wins over the route. `metadata` gives labels
        by document id, used when a document is sorted and saved."""
        self._check_names(categories)
        self._pins.update(categories or {})
        self._labels.update(metadata or {})

    def category_of(self, doc_id: str) -> str:
        """The category of a document: its pin, else the one it had in the
        last run, else the route's default."""
        if doc_id in self._pins:
            return self._pins[doc_id]
        if self._categories is not None and doc_id in self._categories:
            return self._categories[doc_id]
        return self.config.index.default_rule.category

    def _sort(
        self,
        documents: dict[str, SourceFile | str],
        chosen: dict[str, str] | None = None,
        *,
        reuse: bool = False,
        known: dict[str, Sorting] | None = None,
        labels: dict[str, dict[str, str]] | None = None,
    ) -> dict[str, Sorting]:
        """Each document's category and the reason for it. A `known` sorting
        (from the manifest) comes first, then a pin or a name in `chosen`; the
        rest are sorted by the route from the file's cheap facts, or (`reuse`)
        keep what the last run decided."""
        known = known or {}
        pins = {**self._pins, **(chosen or {})}
        labels = {**self._labels, **(labels or {})}
        # Checks are the only reason to read a file; a route without any does not.
        needs_info = any(rule.when for rule in self.config.index.route)
        todo = {
            d: doc
            for d, doc in documents.items()
            if d not in known and pins.get(d) is None and not (reuse and d in self._sortings)
        }
        records = self._source_records(todo) if needs_info and todo and not self._uploads() else {}
        out = {}
        for doc_id, doc in documents.items():
            if doc_id in known:
                out[doc_id] = known[doc_id]
                continue
            pinned = pins.get(doc_id)
            if reuse and pinned is None and doc_id in self._sortings:
                out[doc_id] = self._sortings[doc_id]
                continue
            info = None
            if pinned is None and needs_info:
                info = self._info(doc_id, doc, labels.get(doc_id), records.get(doc_id))
            out[doc_id] = sort_document(self.config.index.route, info, pinned=pinned)
        return out

    def _source_records(self, documents: dict[str, Any]) -> dict[str, dict[str, Any]]:
        """What a custom source gives for each document: its source step alone
        is run first (a cache hit later), so the labels it hands over can route
        the document. A source that fails here is reported by the real run."""
        graph, roles = self.graph(documents)
        sources = {node_id for node_id, (_, role) in roles.items() if role == "source"}
        result = self.execute(graph, targets=sources)
        out = {}
        for node_id in sources:
            artifact = result.nodes[node_id].artifact
            if artifact is not None:
                out[roles[node_id][0]] = self.store.load(artifact.id, artifact.type)
        return out

    def _info(
        self,
        doc_id: str,
        doc: SourceFile | str,
        metadata: dict[str, str] | None = None,
        record: dict[str, Any] | None = None,
    ) -> DocumentInfo:
        """What the route can know about a document. A file that is not on
        disk (a location, or a stored file that is gone) has only its name.
        `record` is what a custom source returned."""
        metadata = {**(record or {}).get("metadata", {}), **(metadata or {})}
        file, name = None, doc_id.rstrip("/").rsplit("/", 1)[-1]
        if isinstance(doc, SourceFile):
            file, name = self.sources.path(doc.sha, doc.filename), doc.filename
        elif record and record.get("path"):
            file, name = Path(record["path"]), record.get("filename", name)
        if file is not None and file.is_file():
            return document_info(file, filename=name, doc_id=doc_id, metadata=metadata)
        return DocumentInfo(
            filename=name, type=format_of(name), size=0, path=doc_id if "/" in doc_id else "",
            metadata=metadata, properties={}, page_count=None, text_layer=None, first_page_text="",
        )

    def _check_names(self, categories: dict[str, str] | None) -> None:
        known = self.config.index.categories
        for name in (categories or {}).values():
            if name not in known:
                raise ValueError(
                    f"There is no category '{name}'. The categories are: {', '.join(known)}."
                )

    def run(
        self,
        paths: Documents,
        *,
        through: str | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        credentials: dict[str, str] | None = None,
        force: bool = False,
        categories: dict[str, str] | None = None,
    ) -> IndexReport:
        """Index the files at `paths`: files, folders, or a list of both.

        A folder gives every file under it except hidden ones, named by its
        path inside the folder with forward slashes (`guides/chunking.pdf`); a
        file is named by its file name. A mapping names each document:
        `{"report.pdf": "/uploads/0f3a.pdf"}` indexes that file as report.pdf.
        An `http(s)://` item is fetched (`pandion.fetch`) and named by its URL;
        a refused one raises `FetchRefused`, a ValueError, before the run starts.
        A step that fails is reported, not raised, and the steps after it are
        skipped. A file the parser cannot read, such as a Word file given to
        pdfium, raises ValueError (`pandion.formats.UnreadableFormat`) before
        the run starts. A PDF or an image behind a Word, PowerPoint, HTML,
        Markdown or text file's name raises it too.

        `through` stops every document after that step: "parse", "clean" (the
        document's last cleaner, or parse when its category has none),
        "clean.1", "clean.2" ..., or "chunk"; "index" is the whole run. The
        report then has no index. `categories` sends documents to categories
        for this call (a document id to a name); `assign` does it for good.
        `on_event`, `cancel`, `credentials` and `force` work as in `execute`.
        """
        stop = self._last_step(through)
        self._check_names(categories)
        return self._index(
            self._documents(paths),
            stop=stop,
            categories=categories,
            on_event=on_event,
            cancel=cancel,
            credentials=credentials,
            force=force,
        )

    def _last_step(self, through: str | None) -> str | None:
        """The step each document stops after, or None for the whole run.
        "clean" stays as it is: each document stops at its own category's
        last cleaner (see `_stop_for`)."""
        if through is None or through == "index":
            return None
        names = self.step_names()
        if through in names:
            return through
        raise ValueError(f"through names the step to stop after: one of {', '.join(names)}, not '{through}'.")

    def step_names(self) -> list[str]:
        """The steps `through` can name: parse, clean, clean.N for as many
        cleaners as the category with the most has, chunk and index."""
        most = max(len(c.clean) for c in self.config.index.categories.values())
        return ["parse", "clean", *[f"clean.{n}" for n in range(1, most + 1)], "chunk", "index"]

    @staticmethod
    def _stop_for(stop: str, category: CategoryConfig) -> str:
        """`stop` for one document: "clean", or a cleaner its category lacks,
        becomes its last cleaner, or parse when it has none."""
        if stop == "clean" or (stop.startswith("clean.") and int(stop[6:]) > len(category.clean)):
            return f"clean.{len(category.clean)}" if category.clean else "parse"
        return stop

    def sync(
        self,
        paths: Documents,
        *,
        credentials: dict[str, str] | None = None,
        metadata: dict[str, dict[str, str]] | None = None,
        categories: dict[str, str] | None = None,
    ) -> SyncReport:
        """Bring the index in line with the files at `paths` now.

        Reads `manifest.json` under the config's `path`, indexes the files the
        same way as `run`, and says which documents were added, changed,
        removed or left unchanged. A changed document is one with new bytes,
        or whose pieces came out different because the settings changed.

        The index is rebuilt, not edited in place, but every step whose inputs
        and settings did not change is a cache hit, so a sync of an unchanged
        folder only reads what is stored. After a sync that worked, the
        manifest is written and the previous index is deleted from the store,
        so the pieces of a removed or changed document are gone. After a sync
        with a failed step, both are left as they were. `credentials` (model
        keys, for a step such as llm_context) work as in `run`.

        A document already in the manifest keeps its category, reason and
        labels, even when its bytes changed: the checks do not run again, and
        `categories` or `metadata` naming it is not applied (`categories` for
        it raises ValueError that points to `p.index.move`). A new one goes
        where `categories` (a document id to a name) says, else where the route
        sends it; `metadata` gives its labels by document id. A manifest
        document in a category the pipeline no longer has raises ValueError
        before anything runs, even if the paths drop that document: move it
        first, or sync without the removal first.
        """
        if not self._uploads():
            raise ValueError(
                "sync works with local files (the upload source); index.run works with any source."
            )
        before = Manifest.load(self.config.path / MANIFEST)
        self._check_recorded(before)
        self._check_names(categories)
        held = [d for d in categories or {} if d in before.documents]
        if held:
            raise ValueError(
                f"{', '.join(held)} already in the index. Use p.index.move to change a category."
            )
        documents = self._documents(paths)
        known = self._recorded(before)
        known.update({d: Sorting(c, "Chosen when added") for d, c in (categories or {}).items()})
        new = {d: m for d, m in (metadata or {}).items() if d not in before.documents}
        return self._commit(documents, before, known, new, credentials=credentials)

    def _check_recorded(self, manifest: Manifest, moving: str | None = None) -> None:
        """Refuse a manifest document whose category the pipeline no longer
        has, naming the documents. `moving` is on its way out and is skipped."""
        gone: dict[str, list[str]] = {}
        for doc_id, entry in sorted(manifest.documents.items()):
            name = entry.get("category")
            if doc_id != moving and name is not None and name not in self.config.index.categories:
                gone.setdefault(name, []).append(doc_id)
        if gone:
            names = ", ".join(f'"{n}"' for n in gone)
            docs = ", ".join(d for ids in gone.values() for d in ids)
            raise ValueError(
                f"These documents are in a category the pipeline no longer has ({names}): {docs}. "
                "Move them to another category first, or put the category back."
            )

    @staticmethod
    def _recorded(manifest: Manifest) -> dict[str, Sorting]:
        """The sorting the manifest recorded, for the documents that have one."""
        return {
            d: Sorting(e["category"], e.get("reason", ""))
            for d, e in manifest.documents.items()
            if "category" in e
        }

    def _commit(
        self,
        documents: dict[str, SourceFile | str],
        before: Manifest,
        known: dict[str, Sorting],
        labels: dict[str, dict[str, str]] | None = None,
        *,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
    ) -> SyncReport:
        """Index `documents` (every document the index should hold), then, if
        every step worked, write the manifest and delete the previous index.
        `known` is the sorting each already-sorted document keeps; `labels`
        are for documents new to the manifest."""
        labels = {
            **{d: e["metadata"] for d, e in before.documents.items() if e.get("metadata")},
            **(labels or {}),
        }
        report = self._index(
            documents, credentials=credentials, on_event=on_event, cancel=cancel, known=known, labels=labels
        )
        recipe = recipe_hash(self.config.index)
        after = Manifest(
            index_recipe=recipe,
            index_artifact=report.index.artifact_id,
            documents={
                doc_id: {
                    "content_hash": file.sha,
                    "chunk_set": report.documents[doc_id].stages["chunk"].artifact_id,
                    "category": report.documents[doc_id].category,
                    "reason": report.documents[doc_id].reason,
                    **({"metadata": labels[doc_id]} if labels.get(doc_id) else {}),
                    # A fetched page's file name comes from its content type.
                    **({} if file.filename == PurePosixPath(doc_id).name else {"filename": file.filename}),
                }
                for doc_id, file in documents.items()
            },
        )

        def same(doc_id: str) -> bool:
            # An entry from before categories has no category to compare.
            old, new = before.documents[doc_id], after.documents[doc_id]
            return (
                old["content_hash"] == new["content_hash"]
                and old["chunk_set"] == new["chunk_set"]
                and old.get("category", new["category"]) == new["category"]
            )

        sync = SyncReport(
            documents=report.documents,
            index=report.index,
            added=sorted(set(after.documents) - set(before.documents)),
            changed=sorted(d for d in after.documents if d in before.documents and not same(d)),
            removed=sorted(set(before.documents) - set(after.documents)),
            unchanged=sorted(d for d in after.documents if d in before.documents and same(d)),
            config_changed=before.index_recipe is not None and before.index_recipe != recipe,
        )
        if sync.ok:
            after.save(self.config.path / MANIFEST)
            if before.index_artifact and before.index_artifact != after.index_artifact:
                self.store.delete(before.index_artifact)
        return sync

    def add(
        self,
        file: str | Path,
        *,
        category: str | None = None,
        metadata: dict[str, str] | None = None,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
    ) -> SyncReport:
        """Add one file or link to the documents in the manifest and save it.

        It goes to `category`, else where the route sends it, and the reason is
        saved. `metadata` is its labels. The index is rebuilt, but every other
        document is a cache hit. The id is the file name, or the link; one that
        is already indexed raises ValueError. Works with the upload source only.
        """
        before, stored = self._stored()
        self._check_recorded(before)
        self._check_names({"": category} if category else None)
        for doc_id in self._ids(file):
            if doc_id in stored:
                raise ValueError(f"`{doc_id}` is already in the index. Use p.index.move to change its category.")
        found = self._documents(file)
        known = self._recorded(before)
        if category:
            known.update({d: Sorting(category, "Chosen when added") for d in found})
        labels = {d: metadata for d in found} if metadata else None
        return self._commit(
            {**stored, **found}, before, known, labels, credentials=credentials, on_event=on_event, cancel=cancel
        )

    def move(
        self,
        document: str,
        category: str,
        *,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
    ) -> SyncReport:
        """Move a document to another category and save it. Only that document
        runs parse, clean and chunk again; its old pieces leave the index. An
        unknown document or category raises ValueError. Moving a document to
        the category it is in runs nothing."""
        before, stored = self._stored()
        if document not in stored:
            raise ValueError(f"`{document}` is not in the index. The documents are: {', '.join(stored) or 'none'}.")
        self._check_names({document: category})
        if before.documents[document].get("category") == category:
            return SyncReport(documents={}, index=None, unchanged=[document])
        self._check_recorded(before, moving=document)
        known = self._recorded(before)
        known[document] = Sorting(category, "Chosen when moved")
        self._pins.pop(document, None)
        return self._commit(stored, before, known, credentials=credentials, on_event=on_event, cancel=cancel)

    def sort(
        self,
        file: str | Path | list[str | Path] | dict[str, str | Path],
        *,
        metadata: dict[str, dict[str, str]] | None = None,
    ) -> dict[str, Sorting]:
        """What category each file would get now, and why, by document id.
        Nothing runs and nothing is written for a file; a link is fetched and
        kept in `sources/`. `metadata` gives labels by document id. A dict
        gives the ids itself, `{document id: file}`: nothing is fetched, and an
        id with a `/` (a link, say) is the path the route's `path` check reads.
        Works with the upload source only."""
        if not self._uploads():
            raise ValueError("sort works with local files (the upload source).")
        given = file if isinstance(file, dict) else {}
        items = [] if isinstance(file, dict) else file if isinstance(file, list) else [file]
        labels = {**self._labels, **(metadata or {})}
        needs_info = any(rule.when for rule in self.config.index.route)
        files = [i for i in items if not is_url(i)]
        infos: dict[str, DocumentInfo | None] = {}
        for doc_id, path in given.items():
            infos[doc_id] = (
                document_info(
                    Path(path), filename=PurePosixPath(doc_id).name, doc_id=doc_id, metadata=labels.get(doc_id)
                )
                if needs_info
                else None
            )
        for doc_id, path in _files(files) if files else []:
            infos[doc_id] = (
                document_info(path, filename=path.name, doc_id=doc_id, metadata=labels.get(doc_id))
                if needs_info
                else None
            )
        for url in (i for i in items if is_url(i)):
            infos[url] = self._info(url, self._fetch(url), labels.get(url)) if needs_info else None
        return {
            doc_id: sort_document(self.config.index.route, info, pinned=self._pins.get(doc_id))
            for doc_id, info in sorted(infos.items())
        }

    def listed(self) -> list[DocumentEntry]:
        """The documents in the manifest, sorted by id."""
        manifest = Manifest.load(self.config.path / MANIFEST)
        return [
            DocumentEntry(
                id=doc_id,
                filename=entry.get("filename", PurePosixPath(doc_id).name),
                category=entry.get("category", "unsorted"),
                reason=entry.get("reason", ""),
                metadata=dict(entry.get("metadata", {})),
                content_hash=entry["content_hash"],
            )
            for doc_id, entry in sorted(manifest.documents.items())
        ]

    def _stored(self) -> tuple[Manifest, dict[str, SourceFile | str]]:
        """The manifest and its documents as stored files (upload only)."""
        if not self._uploads():
            raise ValueError(
                "add, move and sync work with local files (the upload source); index.run works with any source."
            )
        manifest = Manifest.load(self.config.path / MANIFEST)
        return manifest, {
            doc_id: SourceFile(sha=e["content_hash"], filename=e.get("filename", PurePosixPath(doc_id).name))
            for doc_id, e in sorted(manifest.documents.items())
        }

    def _uploads(self) -> bool:
        """The documents are local files (the upload source)."""
        return self.config.index.source[0] == "upload"

    def _ids(self, paths: Documents) -> list[str]:
        """The document ids `_documents` would give, without storing anything."""
        if isinstance(paths, dict):
            return [str(d) for d in paths]
        items = paths if isinstance(paths, list) else [paths]
        files = [i for i in items if not is_url(i)]
        return [d for d, _ in (_files(files) if files else [])] + [str(i) for i in items if is_url(i)]

    def _documents(self, paths: Documents) -> dict[str, SourceFile | str]:
        """By document id: with upload, every file at `paths`, kept in
        `sources/`; with another source, each item as its location. A mapping
        names each document: {document id: file or location}."""
        if isinstance(paths, dict):
            if not paths:
                raise ValueError("There are no documents to index: the mapping is empty.")
            if not self._uploads():
                return {str(doc_id): str(location) for doc_id, location in sorted(paths.items())}
            return {
                str(doc_id): self._fetch(path)
                if is_url(path)
                else self.sources.add_bytes(Path(path).read_bytes(), PurePosixPath(str(doc_id)).name)
                for doc_id, path in sorted(paths.items())
            }
        items = paths if isinstance(paths, list) else [paths]
        if not self._uploads():
            return {str(item).replace("\\", "/"): str(item) for item in items}
        files = [item for item in items if not is_url(item)]
        urls = [item for item in items if is_url(item)]
        # With no URL, _files says when there is nothing to index.
        found = {doc_id: self.sources.add(path) for doc_id, path in _files(files)} if files or not urls else {}
        for url in urls:
            if url in found:
                raise ValueError(f"The document id '{url}' is given twice.")
            found[url] = self._fetch(url)
        return dict(sorted(found.items()))

    def _fetch(self, url: str) -> SourceFile:
        """The page at `url`, fetched behind the guard (`pandion.fetch`) and
        kept in `sources/` like an uploaded file. `models.public_endpoints_only`
        turns on the public-address rule."""
        data, filename = fetch_url(
            url, public_only=self.config.models.public_endpoints_only, max_bytes=URL_MAX_BYTES
        )
        return self.sources.add_bytes(data, filename)

    def _index(
        self,
        documents: dict[str, SourceFile | str],
        *,
        stop: str | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        credentials: dict[str, str] | None = None,
        force: bool = False,
        remember: bool = True,
        categories: dict[str, str] | None = None,
        known: dict[str, Sorting] | None = None,
        labels: dict[str, dict[str, str]] | None = None,
    ) -> IndexReport:
        """Index `documents`. `remember=False` leaves `self.documents` as it
        was; evaluate's trace of a miss uses it so the pipeline is unchanged."""
        # A PDF or an image renamed to a text or office format is refused here,
        # before docling reads it by its bytes and runs its layout or OCR models.
        # A stored file that is gone is not read: a cached index runs without it.
        if self._uploads():
            for doc_id in sorted(documents):
                file = documents[doc_id]
                path = self.sources.path(file.sha, file.filename)
                if path.is_file():
                    check_contents(path, file.filename)
        sorted_ = self._sort(documents, categories, reuse=not remember, known=known, labels=labels)
        chosen = {doc_id: s.category for doc_id, s in sorted_.items()}
        graph, roles = self.graph(documents, chosen)
        known = self.config.index.categories
        targets = {f"{d}::{self._stop_for(stop, known[chosen[d]])}" for d in documents} if stop else None
        result = self.execute(
            graph,
            credentials,
            targets=targets,
            on_event=on_event,
            cancel=cancel,
            force=force,
            roles=roles,
        )
        reports = {doc_id: DocumentReport(category=chosen[doc_id], reason=sorted_[doc_id].reason) for doc_id in documents}
        index = None
        for node in graph.nodes:
            if result.nodes[node.id].status == "pruned":
                continue
            doc_id, role = roles[node.id]
            stage = self.stage_result(node, role, result)
            if doc_id is None:
                index = stage
            else:
                reports[doc_id].stages[role] = stage
        if remember:
            self.documents = documents
            self._categories = chosen
            self._sortings = sorted_
        return IndexReport(documents=reports, index=index)

    def execute(
        self,
        graph: Graph,
        credentials: dict[str, str] | None = None,
        *,
        targets: set[str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        force: bool = False,
        roles: dict[str, tuple[str | None, str]] | None = None,
    ) -> RunResult:
        """Run `graph` through the store, with this pipeline's files and models.

        `credentials` (model keys) reach the steps that call a model; they are
        never hashed, stored or logged. `targets` runs only those nodes and the
        ones above them. `on_event` is called with every event of the run, a
        plain dict, with the step's `document` and `step` added from `roles`;
        if it raises, the run stops and the exception goes to the caller.
        `cancel` stops the run between steps: a step that is running finishes,
        and the rest are skipped. `force` runs every step again even when its
        result is stored.
        """
        discover()
        extras: dict[str, Any] = {
            "sources": self.sources,
            "embedding_cache": self.embedding_cache,
            "models": self.config.models,
            "public_endpoints_only": self.config.models.public_endpoints_only,
        }
        if credentials:
            extras["credentials"] = dict(credentials)
        emit = None
        if on_event is not None:
            names = roles or {}

            def named(node_id: str) -> tuple[str | None, str]:
                return names.get(node_id, (None, node_id))

            def emit(e: dict[str, Any]) -> None:
                if "node_id" in e:
                    doc_id, step = named(e["node_id"])
                    e = {**e, "document": doc_id, "step": step}
                for ids, field_name in _NAMED_LISTS:
                    if isinstance(e.get(ids), list):
                        e = {**e, field_name: [{"document": d, "step": s} for d, s in map(named, e[ids])]}
                on_event(e)

        return run(
            graph,
            registry,
            self.store,
            targets=targets,
            force=force,
            on_event=emit,
            cancelled=cancel.is_set if cancel is not None else None,
            context_extras=extras,
        )

    def indexed(self) -> dict[str, SourceFile | str]:
        """The documents of the last run or sync in this process, including a
        run stopped early by `through` or `cancel`, or else the last sync's,
        read from its manifest (upload only)."""
        if self.documents is not None:
            return self.documents
        if not self._uploads():
            raise ValueError(
                "There is no index to search yet: index some documents first, with p.index.run."
            )
        manifest, stored = self._stored()
        if not manifest.documents:
            raise ValueError(
                "There is no index to search yet: index some files first, with "
                "p.index.run or p.index.sync."
            )
        # Build each document with the category the sync recorded.
        self._check_recorded(manifest)
        recorded = self._recorded(manifest)
        self._categories = {**(self._categories or {}), **{d: s.category for d, s in recorded.items()}}
        self._sortings.update(recorded)
        return stored

    def graph(
        self, documents: dict[str, SourceFile | str], categories: dict[str, str] | None = None
    ) -> tuple[Graph, dict[str, tuple[str | None, str]]]:
        """The graph for `documents`, and each node's (document id, step name).

        Each document has the parse, clean and chunk steps of its category:
        the one in `categories` (document id to name), else `category_of`.
        The index takes every document's chunks in document-id order. With
        the upload source a document is a stored file; with another source it
        is the location that source is told to read.
        """
        index = self.config.index
        nodes: list[Node] = []
        edges: list[Edge] = []
        roles: dict[str, tuple[str | None, str]] = {}

        def add(doc_id: str | None, role: str, stage: Stage, use: str, settings: dict[str, Any]) -> str:
            node_id = role if doc_id is None else f"{doc_id}::{role}"
            nodes.append(Node(node_id, stage, use, settings))
            roles[node_id] = (doc_id, role)
            return node_id

        self._check_names(categories)
        of = {doc_id: (categories or {}).get(doc_id) or self.category_of(doc_id) for doc_id in documents}

        # A file the parser cannot read fails here, before any step runs.
        if self._uploads():
            for doc_id in sorted(documents):
                check_readable(index.categories[of[doc_id]].parse[0], documents[doc_id].filename)

        chunk_nodes = []
        for doc_id in sorted(documents):
            if self._uploads():
                file = documents[doc_id]
                last = add(doc_id, "source", Stage.SOURCE, "upload", {"sha": file.sha, "filename": file.filename})
            else:
                use, settings = index.source
                last = add(doc_id, "source", Stage.SOURCE, use, {**settings, "location": documents[doc_id]})
            category = index.categories[of[doc_id]]
            parse = add(doc_id, "parse", Stage.PARSE, *category.parse)
            edges.append(Edge(last, parse, "file"))
            last = parse
            for n, step in enumerate(category.clean, start=1):
                clean = add(doc_id, f"clean.{n}", Stage.CLEAN, *step)
                edges.append(Edge(last, clean, "doc"))
                last = clean
            chunk = add(doc_id, "chunk", Stage.CHUNK, *category.chunk)
            edges.append(Edge(last, chunk, "doc"))
            if index.enrich is not None:
                enrich = add(doc_id, "enrich", Stage.ENRICH, *index.enrich)
                edges.append(Edge(chunk, enrich, "chunks"))
                chunk = enrich
            chunk_nodes.append(chunk)
        store = add(None, "index", Stage.INDEX, index.store_use, index.store)
        edges += [Edge(chunk, store, "chunks") for chunk in chunk_nodes]
        return Graph(nodes=nodes, edges=edges), roles

    def stage_result(self, node: Node, role: str, result: RunResult) -> StageResult:
        """What the node did in `result`, with its stored output read back."""
        done: NodeResult = result.nodes[node.id]
        artifact = done.artifact
        output = None
        if artifact is not None:
            payload = self.store.load(artifact.id, artifact.type)
            kind = _OUTPUTS.get(node.stage)
            output = kind.model_validate(payload) if kind else payload
        return StageResult(
            stage=role.split(".")[0],
            transform=node.transform,
            output=output,
            status=str(done.status),
            artifact_id=artifact.id if artifact else None,
            duration_ms=done.duration_ms,
            note=artifact.meta.get("note") if artifact else None,
            error=done.error,
            # What the step used in this run: kept for a failed step too, and
            # None for a cached one, whose stored meta holds the usage of the
            # run that made it.
            usage=done.usage,
        )


class RetrievalPipeline:
    """Rewrite (optional), search, and rerank (none, one, or several in order).

    In code: `RetrievalPipeline(index, search=..., rewrite=..., rerank=...)`,
    where `index` is the `IndexPipeline` it searches.
    """

    def __init__(
        self, index: IndexPipeline, *, search: Step, rewrite: Step = None, rerank: Step = None
    ) -> None:
        base = to_dict(index.config)
        config = build(
            path=index.config.path,
            models=index.config.models,
            index=base["index"],
            retrieve={"rewrite": rewrite, "search": search, "rerank": rerank},
            plugins=index.config.plugins,
        )
        self._setup(config, index)

    @classmethod
    def _of(cls, config: PipelineConfig, index: IndexPipeline) -> RetrievalPipeline:
        part = cls.__new__(cls)
        part._setup(config, index)
        return part

    def _setup(self, config: PipelineConfig, index: IndexPipeline) -> None:
        self.config = replace(config, answer=None)
        self.index = index

    @classmethod
    def from_yaml(cls, file: str | Path) -> RetrievalPipeline:
        """The index and retrieval parts of the pipeline file at `file`."""
        retrieval = Pipeline.from_yaml(file).retrieval
        if retrieval is None:
            raise ValueError(f"{file} has no retrieve section.")
        return retrieval

    def to_yaml(self, file: str | Path | None = None) -> str:
        """The index and retrieval parts as a file, also written to `file` if given."""
        return _write(self.config, file)

    def graph(
        self,
        question: str,
        k: int | None = None,
        documents: dict[str, SourceFile | str] | None = None,
        where: dict[str, Any] | None = None,
    ) -> tuple[Graph, dict[str, tuple[str | None, str]]]:
        """The graph that searches the index for `question`, and each node's
        (document id, step name): the index's nodes, then rewrite, search and
        rerank.1, rerank.2 ... with no document id. `documents` (resolved by
        `IndexPipeline._documents`) are the ones to search; None means what
        the index holds. `where` is the search filter (see `pandion.filters`);
        it travels in the rewrite step's settings like the question does."""
        retrieve = self.config.retrieve
        documents = documents if documents is not None else self.index.indexed()
        graph, roles = self.index.graph(documents)
        nodes, edges = list(graph.nodes), list(graph.edges)

        use, settings = retrieve.rewrite or ("text", {})
        settings = {**settings, "text": question}
        filters = _resolve_where(where, documents)
        if filters:
            settings["filters"] = filters
        nodes.append(Node("rewrite", Stage.QUERY, use, settings))
        roles["rewrite"] = (None, "rewrite")
        if _reads_doc(Stage.QUERY, use):
            # A rewrite may read the start of a document. With several, the
            # ambient port cannot choose, so it reads the first one by id.
            edges.append(Edge(_first_doc(roles), "rewrite", "doc"))

        steps = [("search", Stage.RETRIEVE, *retrieve.search)]
        steps += [(f"rerank.{n}", Stage.RERANK, *step) for n, step in enumerate(retrieve.rerank, 1)]
        if k is not None:
            node_id, stage, use, settings = steps[-1]
            steps[-1] = (node_id, stage, use, {**settings, "top_k": k})
        source, port = "index", "index"
        for node_id, stage, use, settings in steps:
            nodes.append(Node(node_id, stage, use, settings))
            roles[node_id] = (None, node_id)
            edges.append(Edge(source, node_id, port))
            source, port = node_id, "result"
        return Graph(nodes=nodes, edges=edges), roles

    def retrieve(
        self,
        question: str,
        k: int | None = None,
        *,
        documents: Documents = None,
        where: dict[str, Any] | None = None,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        force: bool = False,
    ) -> Retrieval:
        """Search the index for `question`, and say what every step did.

        The search runs against the index this pipeline built, through the
        executor and the store, so asking the same question again only reads
        what is stored. `k`, when given, is how many hits the last step keeps
        (its `top_k`); otherwise the file's setting holds. A model's key goes
        in `credentials`, for example `{"anthropic_api_key": ...}`, never in
        the file.

        `documents` (what index.run takes) are the ones to search: the index
        built from exactly them, indexed first through the cache when needed.
        Without it, the search covers what the index holds. `on_event`,
        `cancel` and `force` work as in `IndexPipeline.execute`.

        `where` limits the search to some documents, pages or a section, for
        example `{"document": ["guide.pdf"], "pages": [10, 30], "section":
        "Installing"}`; see `pandion.filters` for the rules. A bad `where`
        raises ValueError before anything runs.
        """
        check_where(where)
        resolved = self.index._documents(documents) if documents is not None else None
        return self._retrieve(
            question, k, resolved, where=where, credentials=credentials,
            on_event=on_event, cancel=cancel, force=force,
        )

    def _retrieve(
        self,
        question: str,
        k: int | None,
        documents: dict[str, SourceFile | str] | None,
        *,
        where: dict[str, Any] | None = None,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        force: bool = False,
    ) -> Retrieval:
        graph, roles = self.graph(question, k, documents, where)
        result = self.index.execute(
            graph, credentials, on_event=on_event, cancel=cancel, force=force, roles=roles
        )
        return self._retrieval(graph, result)

    def _retrieval(self, graph: Graph, result: RunResult) -> Retrieval:
        by_id = {node.id: node for node in graph.nodes}

        def stage_result(node_id: str) -> StageResult:
            return self.index.stage_result(by_id[node_id], node_id.split(".")[0], result)

        return Retrieval(
            stages={
                "rewrite": stage_result("rewrite"),
                "search": stage_result("search"),
                "rerank": [
                    stage_result(f"rerank.{n}")
                    for n in range(1, len(self.config.retrieve.rerank) + 1)
                ],
            },
            index=stage_result("index"),
            upstream=_upstream(graph, result),
        )


#: The node ids a retrieval or an answer reports on its own.
_REPORTED = ("index", "rewrite", "search", "answer")


def _upstream(graph: Graph, result: RunResult) -> list[StageResult]:
    """The other steps that ran or came from the cache, for `cost()` only:
    status, time, usage and id, with no output read back from the store."""
    out = []
    for node in graph.nodes:
        done = result.nodes[node.id]
        if node.id in _REPORTED or node.id.startswith("rerank.") or done.status not in ("executed", "cached", "failed"):
            continue
        out.append(StageResult(
            stage=node.id.split("::")[-1].split(".")[0],
            transform=node.transform,
            output=None,
            status=str(done.status),
            artifact_id=done.artifact.id if done.artifact else None,
            duration_ms=done.duration_ms,
            usage=done.usage,
        ))
    return out


class QueryPipeline:
    """The answer step: `search` (the found pieces as they are) or `chat` (an
    answer whose claims cite them), after the retrieval.

    In code: `QueryPipeline(retrieval, answer=...)`, where `retrieval` is the
    `RetrievalPipeline` whose results it answers from.
    """

    def __init__(self, retrieval: RetrievalPipeline, *, answer: Step) -> None:
        base = to_dict(retrieval.config)
        config = build(
            path=retrieval.config.path,
            models=retrieval.config.models,
            index=base["index"],
            retrieve=base["retrieve"],
            answer=answer,
            plugins=retrieval.config.plugins,
        )
        self._setup(config, retrieval)

    @classmethod
    def _of(cls, config: PipelineConfig, retrieval: RetrievalPipeline) -> QueryPipeline:
        part = cls.__new__(cls)
        part._setup(config, retrieval)
        return part

    def _setup(self, config: PipelineConfig, retrieval: RetrievalPipeline) -> None:
        self.config = config
        self.retrieval = retrieval
        self.index = retrieval.index

    @classmethod
    def from_yaml(cls, file: str | Path) -> QueryPipeline:
        """All three parts of the pipeline file at `file`."""
        query = Pipeline.from_yaml(file).query
        if query is None:
            raise ValueError(f"{file} has no answer section.")
        return query

    def to_yaml(self, file: str | Path | None = None) -> str:
        """All three parts as a file, also written to `file` if given."""
        return _write(self.config, file)

    def graph(
        self,
        question: str,
        k: int | None = None,
        documents: dict[str, SourceFile | str] | None = None,
        where: dict[str, Any] | None = None,
    ) -> tuple[Graph, dict[str, tuple[str | None, str]]]:
        """The retrieval's graph for `question` with the answer step at the end."""
        graph, roles = self.retrieval.graph(question, k, documents, where)
        nodes, edges = list(graph.nodes), list(graph.edges)
        last = graph.nodes[-1].id
        use, settings = self.config.answer
        nodes.append(Node("answer", Stage.USE_CASE, use, settings))
        roles["answer"] = (None, "answer")
        edges.append(Edge(last, "answer", "result"))
        if _reads_doc(Stage.USE_CASE, use):
            # chat, for one, finds each citation in the parsed document. With
            # several documents the ambient port cannot choose, so, as for a
            # rewrite, it reads the first one by id.
            edges.append(Edge(_first_doc(roles), "answer", "doc"))
        return Graph(nodes=nodes, edges=edges), roles

    def ask(
        self,
        question: str,
        k: int | None = None,
        *,
        documents: Documents = None,
        where: dict[str, Any] | None = None,
        credentials: dict[str, str] | None = None,
        on_event: OnEvent | None = None,
        cancel: threading.Event | None = None,
        force: bool = False,
    ) -> Answer:
        """Retrieve for `question`, then run the answer step on what was found.

        `k`, `documents`, `where`, `credentials`, `on_event`, `cancel` and `force` work
        as for `RetrievalPipeline.retrieve`: chat's model key goes in
        `credentials`, for example `{"anthropic_api_key": ...}`. A search
        answer is cached like any step; a chat answer is a new model call
        every time.
        """
        check_where(where)
        resolved = self.index._documents(documents) if documents is not None else None
        graph, roles = self.graph(question, k, resolved, where)
        result = self.index.execute(
            graph, credentials, on_event=on_event, cancel=cancel, force=force, roles=roles
        )
        answer = next(node for node in graph.nodes if node.id == "answer")
        return Answer(
            retrieval=self.retrieval._retrieval(graph, result),
            answer=self.index.stage_result(answer, "answer", result),
        )


def _reads_doc(stage: Stage, use: str) -> bool:
    """True when the strategy declares a doc input, so it is given the parsed document."""
    return "doc" in registry.get(stage, use).inputs


def _first_doc(roles: dict[str, tuple[str | None, str]]) -> str:
    """The node holding the first document by id as parsed and cleaned: the
    last step before its chunker."""
    first = min(doc_id for doc_id, _ in roles.values() if doc_id is not None)
    return [n for n, (d, role) in roles.items() if d == first and role not in ("source", "chunk", "enrich")][-1]


def _write(config: PipelineConfig, file: str | Path | None) -> str:
    text = yaml.safe_dump(to_dict(config), sort_keys=False, allow_unicode=True)
    if file is not None:
        Path(file).write_text(text, encoding="utf-8")
    return text


def _files(paths: str | Path | list[str | Path]) -> list[tuple[str, Path]]:
    """(document id, file) for every file at `paths`, sorted by document id."""
    found: dict[str, Path] = {}
    for given in [paths] if isinstance(paths, (str, Path)) else paths:
        given = Path(given)
        if given.is_dir():
            pairs = [
                (p.relative_to(given).as_posix(), p)
                for p in given.rglob("*")
                if p.is_file() and not any(part.startswith(".") for part in p.relative_to(given).parts)
            ]
        else:
            pairs = [(given.name, given)]
        for doc_id, path in pairs:
            if doc_id in found:
                raise ValueError(
                    f"Two files have the document id '{doc_id}': {found[doc_id]} and {path}. "
                    "Rename one, or index them from one folder."
                )
            found[doc_id] = path
    if not found:
        raise ValueError(f"There are no files to index at {paths}.")
    return sorted(found.items())
