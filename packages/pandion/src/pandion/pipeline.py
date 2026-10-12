"""A pipeline from a config file, run through the executor and the store.

```python
from pandion import Pipeline

p = Pipeline.from_file("pipeline.yaml")
report = p.index.run("docs/")
report.documents["guides/chunking.pdf"].stages["parse"].output   # a ParsedDoc
report.index.output                                              # the index folder

report = p.index.sync("docs/")      # later, after files were added, changed or removed
report.added, report.changed, report.removed, report.unchanged
```

Every step is cached by its recipe hash, so running the same files with the
same config again only reads what is stored. Under the config's `path` Pandion
keeps `sources/` (each file once, by its fingerprint), `artifacts/` (the store),
`embeddings/` (the embedding cache) and, after a sync, `manifest.json` (see
`pandion.manifest`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pandion.config import PipelineConfig, load
from pandion.embedding_cache import EmbeddingCache
from pandion.executor import NodeResult, RunResult, run
from pandion.graph import Edge, Graph, Node
from pandion.manifest import MANIFEST, Manifest, recipe_hash
from pandion.payloads import ChunkSet, ParsedDoc
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry
from pandion.results import StageResult
from pandion.sources import SourceFile, Sources
from pandion.storage import Store

#: How each stored payload is handed back in a `StageResult`.
_OUTPUTS = {Stage.PARSE: ParsedDoc, Stage.CLEAN: ParsedDoc, Stage.CHUNK: ChunkSet}


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


class Pipeline:
    """The parts of a pipeline file. For now, the index."""

    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
        self.index = IndexPipeline(config)

    @classmethod
    def from_file(cls, file: str | Path) -> Pipeline:
        """Read and check `file` (see `pandion.config`); nothing runs yet."""
        return cls(load(file))


class IndexPipeline:
    """Parse, clean, chunk, embed and store, for many documents into one index."""

    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
        root = config.path
        self.sources = Sources(root / "sources")
        self.store = Store(root / "artifacts")
        self.embedding_cache = EmbeddingCache(root / "embeddings")

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
        discover()
        graph, roles = self.graph(documents)
        result = run(
            graph,
            registry,
            self.store,
            context_extras={
                "sources": self.sources,
                "embedding_cache": self.embedding_cache,
                "models": self.config.models,
            },
        )
        reports = {doc_id: DocumentReport() for doc_id in documents}
        for node in graph.nodes:
            doc_id, role = roles[node.id]
            stage = self._result(node, role, result)
            if doc_id is None:
                index = stage
            else:
                reports[doc_id].stages[role] = stage
        return IndexReport(documents=reports, index=index)

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

    def _result(self, node: Node, role: str, result: RunResult) -> StageResult:
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
