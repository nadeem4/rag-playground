"""A pipeline from a config file, run through the executor and the store.

```python
from pandion import Pipeline

p = Pipeline.from_file("pipeline.yaml")
report = p.index.run("docs/")
report.documents["guides/chunking.pdf"].stages["parse"].output   # a ParsedDoc
report.index.output                                              # the index folder

report = p.index.sync("docs/")      # later, after files were added, changed or removed
report.added, report.changed, report.removed, report.unchanged

result = p.retrieve("How big should a chunk be?", k=5)
result.hits                         # the hits, best first
result.stages["search"].output      # what the search step found, before reranking
```

Every step is cached by its recipe hash, so running the same files with the
same config again only reads what is stored. Under the config's `path` Pandion
keeps `sources/` (each file once, by its fingerprint), `artifacts/` (the store),
`embeddings/` (the embedding cache) and, after a sync, `manifest.json` (see
`pandion.manifest`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from pandion.config import PipelineConfig, load
from pandion.embedding_cache import EmbeddingCache
from pandion.executor import NodeResult, RunResult, run
from pandion.graph import Edge, Graph, Node
from pandion.manifest import MANIFEST, Manifest, recipe_hash
from pandion.payloads import ChunkSet, Hit, ParsedDoc, Query, RetrievalResult
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
}


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


class Pipeline:
    """The parts of a pipeline file: the index and the retrieval."""

    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
        self.index = IndexPipeline(config)
        self.retrieval = RetrievalPipeline(config, self.index)

    @classmethod
    def from_file(cls, file: str | Path) -> Pipeline:
        """Read and check `file` (see `pandion.config`); nothing runs yet."""
        return cls(load(file))

    def retrieve(
        self, question: str, k: int | None = None, *, credentials: dict[str, str] | None = None
    ) -> Retrieval:
        """Search the index for `question`. See `RetrievalPipeline.retrieve`."""
        return self.retrieval.retrieve(question, k, credentials=credentials)


class IndexPipeline:
    """Parse, clean, chunk, embed and store, for many documents into one index."""

    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
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
    """Rewrite (optional), search, and rerank (none, one, or several in order)."""

    def __init__(self, config: PipelineConfig, index: IndexPipeline) -> None:
        self.config = config
        self.index = index

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
        retrieve = self.config.retrieve
        if retrieve is None:
            raise ValueError(
                "The pipeline file has no retrieve section, so there is nothing to "
                "search with. Add retrieve: with at least a search step."
            )
        graph, roles = self.index.graph(self.index.indexed())
        nodes, edges = list(graph.nodes), list(graph.edges)

        use, settings = retrieve.rewrite or ("text", {})
        nodes.append(Node("rewrite", Stage.QUERY, use, {**settings, "text": question}))
        if use != "text":
            # A rewrite may read the start of a document. With several, the
            # ambient port cannot choose, so it reads the first one by id: the
            # last step before its chunker.
            first = min(doc_id for doc_id, _ in roles.values() if doc_id is not None)
            doc = [n for n, (d, role) in roles.items() if d == first and role not in ("source", "chunk")][-1]
            edges.append(Edge(doc, "rewrite", "doc"))

        steps = [("search", Stage.RETRIEVE, *retrieve.search)]
        steps += [(f"rerank.{n}", Stage.RERANK, *step) for n, step in enumerate(retrieve.rerank, 1)]
        if k is not None:
            node_id, stage, use, settings = steps[-1]
            steps[-1] = (node_id, stage, use, {**settings, "top_k": k})
        source, port = "index", "index"
        for node_id, stage, use, settings in steps:
            nodes.append(Node(node_id, stage, use, settings))
            edges.append(Edge(source, node_id, port))
            source, port = node_id, "result"

        whole = Graph(nodes=nodes, edges=edges)
        result = self.index.execute(whole, credentials)
        by_id = {node.id: node for node in whole.nodes}

        def stage_result(node_id: str) -> StageResult:
            return self.index.stage_result(by_id[node_id], node_id.split(".")[0], result)

        return Retrieval(
            stages={
                "rewrite": stage_result("rewrite"),
                "search": stage_result("search"),
                "rerank": [stage_result(f"rerank.{n}") for n in range(1, len(retrieve.rerank) + 1)],
            },
            index=stage_result("index"),
        )


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
