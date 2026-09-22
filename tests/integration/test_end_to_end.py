"""The phase acceptance test: one graph, every stage, a real answer.

Nothing here is mocked except the *location* of the global source directory.
The PDF is generated, parsed by pypdfium2, cleaned, chunked, embedded into a
real LanceDB table, searched, reranked and formatted — so what this asserts is
the pipeline, not a set of agreeing stubs.

The query node is deliberately left unwired. It has no edge to the retriever or
the reranker, and both nonetheless receive it, because `query` is an ambient
port bound to the graph's unique terminal producer of `query`. That is the
mechanism a linear column UI needs in order to exist at all, and
`test_query_binds_ambiently` is what proves it resolved rather than defaulted.

**Every run-based test is parametrized over the rerank node's presence**, so the
acceptance criteria are proven both with and without a reranker in the graph.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from core.artifacts import ArtifactType
from core.executor import NodeStatus, run, sweep
from core.graph import Edge, Graph, Node
from core.ports import Stage
from core.registry import registry
from core.storage import Store
from plugins.source import upload
from tests.plugins.conftest import SAMPLE_PAGES, build_pdf


#: The query driven through the whole pipeline. The fake embedder is graded
#: (~0.68 cosine for related text, ~0 for unrelated), so retrieving TARGET over
#: the other five sentences is a real semantic assertion, not a formality.
QUESTION = "What is the capital of France?"

#: The sentence the pipeline must surface, from page 1 of the fixture PDF.
TARGET = "The capital of France is Paris."

#: Small enough that the document becomes several competing chunks rather than
#: one chunk that trivially contains the answer.
CHUNK_SIZE = 70


#: Both shapes of the acceptance graph. Only the reranker is in question; every
#: other stage is exercised identically by both.
SHAPES = [
    pytest.param(False, id="no_rerank"),
    pytest.param(True, id="with_rerank"),
]


def graph(
    sha: str,
    filename: str,
    *,
    rerank: bool = True,
    retriever: str = "dense",
    **index_cfg,
) -> Graph:
    """source -> parse -> clean -> chunk -> index -> retrieve -> rerank -> use_case.

    Plus `q`, which has no outgoing edge at all.
    """
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": filename}),
        Node("q", Stage.QUERY, "text", {"text": QUESTION}),
        Node("parse", Stage.PARSE, "pdfium", {}),
        Node("clean", Stage.CLEAN, "header_footer_strip", {}),
        Node(
            "chunk",
            Stage.CHUNK,
            "recursive_character",
            {"chunk_size": CHUNK_SIZE, "chunk_overlap": 0},
        ),
        # The fake embedder unless a test says otherwise: the fast suite never
        # downloads a model.
        Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"} | index_cfg),
        Node("retrieve", Stage.RETRIEVE, retriever, {"top_k": 20}),
        Node("uc", Stage.USE_CASE, "search", {}),
    ]
    edges = [
        Edge("src", "parse", "file"),
        Edge("parse", "clean", "doc"),
        Edge("clean", "chunk", "doc"),
        Edge("chunk", "index", "chunks"),
        Edge("index", "retrieve", "index"),
    ]
    if rerank:
        nodes.append(Node("rerank", Stage.RERANK, "mmr", {"top_k": 5}))
        edges += [Edge("retrieve", "rerank", "result"), Edge("rerank", "uc", "result")]
    else:
        edges.append(Edge("retrieve", "uc", "result"))
    return Graph(nodes=nodes, edges=edges)


def node_ids(rerank: bool) -> set[str]:
    base = {"src", "q", "parse", "clean", "chunk", "index", "retrieve", "uc"}
    return base | {"rerank"} if rerank else base


@pytest.fixture
def source(tmp_path: Path, monkeypatch) -> tuple[str, str]:
    """Put the fixture PDF into a relocated `sources/`, content-addressed.

    `upload` resolves `SOURCES_DIR / f"{sha}{suffix}"`, so the stored name is
    the sha plus the original file's extension — that is the naming rule, and a
    test has to honour it exactly or the node just raises FileNotFoundError.
    """
    sources = tmp_path / "sources"
    sources.mkdir()
    data = build_pdf(SAMPLE_PAGES)
    sha = hashlib.sha256(data).hexdigest()
    (sources / f"{sha}.pdf").write_bytes(data)
    monkeypatch.setattr(upload, "SOURCES_DIR", sources)
    return sha, "sample.pdf"


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(tmp_path / "store")


def statuses(result) -> dict[str, NodeStatus]:
    return {nid: node.status for nid, node in result.nodes.items()}


def output_of(result, store: Store, node_id: str = "uc") -> dict:
    return store.load(result.nodes[node_id].artifact.id, ArtifactType.OUTPUT)


def _failures(result) -> str:
    return "\n".join(
        f"{nid}: {node.error}"
        for nid, node in result.nodes.items()
        if node.status is NodeStatus.FAILED
    )


# ---------------------------------------------------------------------------
# 1 + 2: it runs, and it finds the right passage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rerank", SHAPES)
def test_full_pipeline_runs_and_retrieves_the_matching_passage(source, store, rerank):
    sha, filename = source
    result = run(graph(sha, filename, rerank=rerank), registry, store)

    assert result.ok, _failures(result)
    assert statuses(result) == dict.fromkeys(node_ids(rerank), NodeStatus.EXECUTED)

    out = output_of(result, store)
    assert out["kind"] == "search"
    rows = out["payload"]["results"]
    assert rows, "the pipeline returned no hits at all"

    # The graded fake embedder scores related text around 0.68 and unrelated
    # text near 0, so this is a real retrieval assertion.
    assert TARGET in rows[0]["snippet"], (
        f"expected the top hit to contain {TARGET!r}, got "
        + json.dumps([r["snippet"] for r in rows], indent=2)
    )


def test_query_binds_ambiently(source, store):
    """No edge reaches `retrieve.query` or `rerank.query`; both still resolve.

    Validation only — this one covers the full graph, reranker included, because
    ambient resolution happens before any transform is constructed.
    """
    sha, filename = source
    g = graph(sha, filename, rerank=True)
    assert not [e for e in g.edges if e.src == "q"]

    resolved = g.validate(registry)
    assert resolved.bindings["retrieve"]["query"] == "q"
    assert resolved.bindings["rerank"]["query"] == "q"
    assert "q" in resolved.parents["retrieve"]
    assert "q" in resolved.parents["rerank"]


# ---------------------------------------------------------------------------
# 3: the citation quotes the document, not the embedding projection
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rerank", SHAPES)
def test_use_case_cites_the_original_chunk_text(source, store, rerank):
    sha, filename = source
    result = run(graph(sha, filename, rerank=rerank), registry, store)
    assert result.ok, _failures(result)

    chunk_set = store.load(result.nodes["chunk"].artifact.id, ArtifactType.CHUNK_SET)
    by_id = {c["id"]: c for c in chunk_set["chunks"]}

    rows = output_of(result, store)["payload"]["results"]
    assert rows
    for row in rows:
        chunk = by_id[row["chunk_id"]]
        assert row["snippet"] == chunk["text"][: len(row["snippet"])]
        assert chunk["text"] in chunk_set["source_text"]


# ---------------------------------------------------------------------------
# 4: the second run does no work
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rerank", SHAPES)
def test_second_identical_run_is_entirely_cached(source, store, rerank, monkeypatch):
    sha, filename = source
    g = graph(sha, filename, rerank=rerank)
    first = run(g, registry, store)
    assert first.ok, _failures(first)

    # Belt and braces: an `apply` that runs at all is a bug, so make it say so.
    calls: list[str] = []
    for stage in {nd.stage for nd in g.nodes}:
        for cls in registry.all_for(stage).values():

            def guarded(self, inputs, config, ctx, _original=cls.apply, _cls=cls):
                calls.append(_cls.name)
                return _original(self, inputs, config, ctx)

            monkeypatch.setattr(cls, "apply", guarded)

    second = run(graph(sha, filename, rerank=rerank), registry, store)

    assert second.ok, _failures(second)
    assert statuses(second) == dict.fromkeys(node_ids(rerank), NodeStatus.CACHED)
    assert calls == [], f"transforms executed on a fully cached run: {calls}"

    # Same recipe, same ids — the cache hit is on the artifact, not on luck.
    assert {n: r.artifact.id for n, r in second.nodes.items()} == {
        n: r.artifact.id for n, r in first.nodes.items()
    }


# ---------------------------------------------------------------------------
# 5: sweeping the chunker parses once
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rerank", SHAPES)
def test_chunker_sweep_reuses_upstream_and_produces_distinct_chunk_sets(
    source, store, rerank
):
    sha, filename = source
    out = sweep(
        graph(sha, filename, rerank=rerank),
        registry,
        store,
        node_id="chunk",
        variants=[
            {
                "transform": "recursive_character",
                "config": {"chunk_size": CHUNK_SIZE, "chunk_overlap": 0},
            },
            {"transform": "markdown_header", "config": {"max_tokens": 32}},
            {"transform": "token_based", "config": {"max_tokens": 32, "overlap": 0}},
        ],
        through="uc",
    )

    assert len(out.runs) == 3
    for i, r in enumerate(out.runs):
        assert r.ok, f"variant {i}: {_failures(r)}"

    executed_parse = [
        i
        for i, r in enumerate(out.runs)
        if r.nodes["parse"].status is NodeStatus.EXECUTED
    ]
    assert executed_parse == [0], (
        "parse must run exactly once across the sweep; it executed in variants "
        f"{executed_parse}"
    )
    assert all(r.nodes["parse"].status is NodeStatus.CACHED for r in out.runs[1:])

    chunk_ids = [r.nodes["chunk"].artifact.id for r in out.runs]
    assert len(set(chunk_ids)) == 3, f"chunk sets were not distinct: {chunk_ids}"

    # And the sweep was scored end to end, not stopped at the chunks.
    for r in out.runs:
        assert r.nodes["uc"].status is NodeStatus.EXECUTED


# ---------------------------------------------------------------------------
# 6 + 7: swapping the retriever, and the backend contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rerank", SHAPES)
def test_bm25_retriever_runs_against_the_default_index(source, store, rerank):
    sha, filename = source
    g = graph(sha, filename, rerank=rerank, retriever="bm25")
    g.validate(registry)  # the index builds FTS by default

    result = run(g, registry, store)
    assert result.ok, _failures(result)
    assert result.nodes["retrieve"].status is NodeStatus.EXECUTED
    rows = output_of(result, store)["payload"]["results"]
    assert rows and all(row["retriever"] == "bm25" for row in rows)


def test_bm25_against_a_no_fts_index_is_rejected_at_run_time(source, store):
    """Validation passes; the run fails.

    `Transform.provides` is a *static* claim — `lancedb` says it can build both
    backends — so graph validation cannot see that this particular node was
    configured with `build_fts=False`. The descriptor inside the built index
    can, and that is where the refusal comes from. The full graph including the
    reranker is used here: a node whose parent is broken is SKIPPED before it is
    ever constructed, so the mmr bug is not reached.
    """
    sha, filename = source
    g = graph(sha, filename, rerank=True, retriever="bm25", build_fts=False)

    g.validate(registry)  # does NOT raise: the mismatch is not statically visible

    result = run(g, registry, store)
    assert not result.ok
    assert result.nodes["retrieve"].status is NodeStatus.FAILED
    assert "needs the 'fts' backend" in result.nodes["retrieve"].error
    # Downstream is skipped, not failed, and nothing was committed for it.
    assert result.nodes["uc"].status is NodeStatus.SKIPPED
    assert result.nodes["uc"].artifact is None
