"""A pipeline in three parts, run through the executor and the store.

```python
from pandion import Pipeline

p = Pipeline.from_yaml("pipeline.yaml")
report = p.index.run("docs/")
report.documents["guides/chunking.pdf"].stages["parse"].output   # a ParsedDoc
report.index.output                                              # the index folder

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

from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from pandion.config import PipelineConfig, build, load, to_dict
from pandion.embedding_cache import EmbeddingCache
from pandion.executor import NodeResult, RunResult, run
from pandion.graph import Edge, Graph, Node
from pandion.manifest import MANIFEST, Manifest, recipe_hash
from pandion.payloads import ChunkSet, Hit, Output, ParsedDoc, Query, RetrievalResult
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry
from pandion.results import StageResult
from pandion.sources import SourceFile, Sources
from pandion.storage import Store

#: How each stored payload is handed back in a `StageResult`.
_OUTPUTS = {
    Stage.PARSE: ParsedDoc,
    Stage.CLEAN: ParsedDoc,
    Stage.CHUNK: ChunkSet,
    Stage.QUERY: Query,
    Stage.RETRIEVE: RetrievalResult,
    Stage.RERANK: RetrievalResult,
    Stage.USE_CASE: Output,
}

#: Settings a stage may take: a dict (the file's block), a step class, a name.
Step = Any


@dataclass
class DocumentReport:
    """What each step did to one document, keyed source, parse, clean.1 ..., chunk."""

    stages: dict[str, StageResult] = field(default_factory=dict)


@dataclass
class IndexReport:
    """One index run: each document's steps, and the index built from them all."""

    documents: dict[str, DocumentReport]
    index: StageResult

    @property
    def ok(self) -> bool:
        return all(
            s.status != "failed"
            for s in [self.index, *(s for d in self.documents.values() for s in d.stages.values())]
        )


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
    """

    stages: dict[str, Any]
    index: StageResult

    def _steps(self) -> list[StageResult]:
        return [self.index, self.stages["rewrite"], self.stages["search"], *self.stages["rerank"]]

    @property
    def ok(self) -> bool:
        return all(s.status in ("executed", "cached") for s in self._steps())

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

    @property
    def hits(self) -> list[Hit]:
        return self.retrieval.hits

    @property
    def output(self) -> Output | None:
        return self.answer.output if self.ok else None

    @property
    def text(self) -> str:
        """The chat answer as one text, or the found pieces one after another."""
        if self.output is None:
            return ""
        payload = self.output.payload
        if self.output.kind == "chat":
            return "".join(segment["text"] for segment in payload["answer"])
        return "\n\n".join(row["snippet"] for row in payload["results"])


class Pipeline:
    """All three parts: the index, the retrieval and the answer step.

    Build one from a file with `from_yaml`, or in code with a keyword per stage:

        Pipeline(path="./my-index", parse=Docling(do_ocr=False),
                 chunk={"use": "recursive_character", "chunk_size": 400},
                 embed="qwen3-embedding-0.6b", store="lancedb",
                 search=HybridRrf(top_k=20), rerank=[CrossEncoder(top_k=5)],
                 answer="search")

    Each stage is a dict (the file's block for it), a step class or a name.
    `retrieval` is None without a search step and `query` is None without an
    answer step.
    """

    def __init__(
        self,
        *,
        path: str | Path,
        parse: Step,
        chunk: Step,
        embed: Step,
        store: Step,
        clean: Step = None,
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
                index={"parse": parse, "clean": clean, "chunk": chunk, "embed": embed, "store": store},
                retrieve={"rewrite": rewrite, "search": search, "rerank": rerank},
                answer=answer,
            )
        )

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

    def retrieve(
        self, question: str, k: int | None = None, *, credentials: dict[str, str] | None = None
    ) -> Retrieval:
        """Search the index for `question`. See `RetrievalPipeline.retrieve`."""
        if self.retrieval is None:
            raise ValueError(
                "The pipeline has no retrieve section, so there is nothing to "
                "search with. Add retrieve: with at least a search step."
            )
        return self.retrieval.retrieve(question, k, credentials=credentials)

    def ask(
        self, question: str, k: int | None = None, *, credentials: dict[str, str] | None = None
    ) -> Answer:
        """Answer `question`. See `QueryPipeline.ask`."""
        if self.query is None:
            raise ValueError(
                "The pipeline has no answer section, so there is nothing to answer "
                "with. Add answer: with search or chat."
            )
        return self.query.ask(question, k, credentials=credentials)


class IndexPipeline:
    """Parse, clean, chunk, embed and store, for many documents into one index.

    In code: `IndexPipeline(path=..., parse=..., chunk=..., embed=..., store=...)`,
    with `clean` (one cleaner or a list) and `models` optional.
    """

    def __init__(
        self,
        *,
        path: str | Path,
        parse: Step,
        chunk: Step,
        embed: Step,
        store: Step,
        clean: Step = None,
        models: Any = None,
    ) -> None:
        self._setup(
            build(
                path=path,
                models=models,
                index={"parse": parse, "clean": clean, "chunk": chunk, "embed": embed, "store": store},
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
        #: The documents the last run or sync in this process indexed.
        self.documents: dict[str, SourceFile] | None = None

    def run(self, paths: str | Path | list[str | Path]) -> IndexReport:
        """Index the files at `paths`: files, folders, or a list of both.

        A folder gives every file under it except hidden ones, named by its
        path inside the folder with forward slashes (`guides/chunking.pdf`); a
        file is named by its file name. A step that fails is reported, not
        raised, and the steps after it are skipped.
        """
        return self._index(self._documents(paths))

    def sync(self, paths: str | Path | list[str | Path]) -> SyncReport:
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
        with a failed step, both are left as they were.
        """
        manifest_path = self.config.path / MANIFEST
        before = Manifest.load(manifest_path)
        documents = self._documents(paths)
        report = self._index(documents)
        recipe = recipe_hash(self.config.index)
        after = Manifest(
            index_recipe=recipe,
            index_artifact=report.index.artifact_id,
            documents={
                doc_id: {
                    "content_hash": file.sha,
                    "chunk_set": report.documents[doc_id].stages["chunk"].artifact_id,
                }
                for doc_id, file in documents.items()
            },
        )
        sync = SyncReport(
            documents=report.documents,
            index=report.index,
            added=sorted(set(after.documents) - set(before.documents)),
            changed=sorted(
                d for d in after.documents if d in before.documents and after.documents[d] != before.documents[d]
            ),
            removed=sorted(set(before.documents) - set(after.documents)),
            unchanged=sorted(d for d in after.documents if after.documents[d] == before.documents.get(d)),
            config_changed=before.index_recipe is not None and before.index_recipe != recipe,
        )
        if sync.ok:
            after.save(manifest_path)
            if before.index_artifact and before.index_artifact != after.index_artifact:
                self.store.delete(before.index_artifact)
        return sync

    def _documents(self, paths: str | Path | list[str | Path]) -> dict[str, SourceFile]:
        """Every file at `paths`, kept in `sources/`, by document id."""
        return {doc_id: self.sources.add(path) for doc_id, path in _files(paths)}

    def _index(self, documents: dict[str, SourceFile]) -> IndexReport:
        graph, roles = self.graph(documents)
        result = self.execute(graph)
        reports = {doc_id: DocumentReport() for doc_id in documents}
        for node in graph.nodes:
            doc_id, role = roles[node.id]
            stage = self.stage_result(node, role, result)
            if doc_id is None:
                index = stage
            else:
                reports[doc_id].stages[role] = stage
        self.documents = documents
        return IndexReport(documents=reports, index=index)

    def execute(self, graph: Graph, credentials: dict[str, str] | None = None) -> RunResult:
        """Run `graph` through the store, with this pipeline's files and models.

        `credentials` (model keys) reach the steps that call a model; the
        executor never hashes or stores them.
        """
        discover()
        extras: dict[str, Any] = {
            "sources": self.sources,
            "embedding_cache": self.embedding_cache,
            "models": self.config.models,
        }
        if credentials:
            extras["credentials"] = dict(credentials)
        return run(graph, registry, self.store, context_extras=extras)

    def indexed(self) -> dict[str, SourceFile]:
        """The documents in the index: the last run's or sync's in this
        process, or else the last sync's, read from its manifest."""
        if self.documents is not None:
            return self.documents
        manifest = Manifest.load(self.config.path / MANIFEST)
        if not manifest.documents:
            raise ValueError(
                "There is no index to search yet: index some files first, with "
                "p.index.run or p.index.sync."
            )
        return {
            doc_id: SourceFile(sha=entry["content_hash"], filename=PurePosixPath(doc_id).name)
            for doc_id, entry in manifest.documents.items()
        }

    def graph(self, documents: dict[str, SourceFile]) -> tuple[Graph, dict[str, tuple[str | None, str]]]:
        """The graph for `documents`, and each node's (document id, step name).

        The index takes every document's chunks in document-id order.
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

        chunk_nodes = []
        for doc_id in sorted(documents):
            file = documents[doc_id]
            last = add(doc_id, "source", Stage.SOURCE, "upload", {"sha": file.sha, "filename": file.filename})
            parse = add(doc_id, "parse", Stage.PARSE, *index.parse)
            edges.append(Edge(last, parse, "file"))
            last = parse
            for n, step in enumerate(index.clean, start=1):
                clean = add(doc_id, f"clean.{n}", Stage.CLEAN, *step)
                edges.append(Edge(last, clean, "doc"))
                last = clean
            chunk = add(doc_id, "chunk", Stage.CHUNK, *index.chunk)
            edges.append(Edge(last, chunk, "doc"))
            chunk_nodes.append(chunk)
        store = add(None, "index", Stage.INDEX, "lancedb", index.store)
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

    def graph(self, question: str, k: int | None = None) -> tuple[Graph, dict[str, tuple[str | None, str]]]:
        """The graph that searches the index for `question`, and each node's
        (document id, step name): the index's nodes, then rewrite, search and
        rerank.1, rerank.2 ... with no document id."""
        retrieve = self.config.retrieve
        graph, roles = self.index.graph(self.index.indexed())
        nodes, edges = list(graph.nodes), list(graph.edges)

        use, settings = retrieve.rewrite or ("text", {})
        nodes.append(Node("rewrite", Stage.QUERY, use, {**settings, "text": question}))
        roles["rewrite"] = (None, "rewrite")
        if use != "text":
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
        self, question: str, k: int | None = None, *, credentials: dict[str, str] | None = None
    ) -> Retrieval:
        """Search the index for `question`, and say what every step did.

        The search runs against the index this pipeline built, through the
        executor and the store, so asking the same question again only reads
        what is stored. `k`, when given, is how many hits the last step keeps
        (its `top_k`); otherwise the file's setting holds. A model's key goes
        in `credentials`, for example `{"anthropic_api_key": ...}`, never in
        the file.
        """
        graph, _ = self.graph(question, k)
        return self._retrieval(graph, self.index.execute(graph, credentials))

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
        )


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

    def graph(self, question: str, k: int | None = None) -> tuple[Graph, dict[str, tuple[str | None, str]]]:
        """The retrieval's graph for `question` with the answer step at the end."""
        graph, roles = self.retrieval.graph(question, k)
        nodes, edges = list(graph.nodes), list(graph.edges)
        last = graph.nodes[-1].id
        use, settings = self.config.answer
        nodes.append(Node("answer", Stage.USE_CASE, use, settings))
        roles["answer"] = (None, "answer")
        edges.append(Edge(last, "answer", "result"))
        if use == "chat":
            # chat finds each citation in the parsed document. With several
            # documents the ambient port cannot choose, so, as for a rewrite,
            # it reads the first one by id.
            edges.append(Edge(_first_doc(roles), "answer", "doc"))
        return Graph(nodes=nodes, edges=edges), roles

    def ask(
        self, question: str, k: int | None = None, *, credentials: dict[str, str] | None = None
    ) -> Answer:
        """Retrieve for `question`, then run the answer step on what was found.

        `k` and `credentials` work as for `RetrievalPipeline.retrieve`: chat's
        model key goes in `credentials`, for example `{"anthropic_api_key":
        ...}`. A search answer is cached like any step; a chat answer is a new
        model call every time.
        """
        graph, _ = self.graph(question, k)
        result = self.index.execute(graph, credentials)
        answer = next(node for node in graph.nodes if node.id == "answer")
        return Answer(
            retrieval=self.retrieval._retrieval(graph, result),
            answer=self.index.stage_result(answer, "answer", result),
        )


def _first_doc(roles: dict[str, tuple[str | None, str]]) -> str:
    """The node holding the first document by id as parsed and cleaned: the
    last step before its chunker."""
    first = min(doc_id for doc_id, _ in roles.values() if doc_id is not None)
    return [n for n, (d, role) in roles.items() if d == first and role not in ("source", "chunk")][-1]


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
