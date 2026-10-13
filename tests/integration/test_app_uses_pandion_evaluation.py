"""The app's eval step and pandion.evaluate give the same verdict.

The Evaluate page still runs `eval` as a graph node through POST /api/sweeps,
with the gold answer in the question node's settings, and adds up the scores
in the browser (part 5 switches it to pandion.evaluate). Until then both must
agree: the same file, settings and question give the same eval payload.
"""

from __future__ import annotations

import pandion
from api.deps import build_deps
from pandion import Pipeline
from pandion.artifacts import ArtifactType
from pandion.executor import run
from pandion.graph import Edge, Graph, Node
from pandion.payloads import Output
from pandion.ports import Stage
from tests.steps.conftest import SAMPLE_PAGES, build_pdf

QUESTION = "What is the capital of France?"
GOLD = "The capital of France is Paris."
CHUNK = {"chunk_size": 70, "chunk_overlap": 10}
SEARCH = {"top_k": 5}


def test_the_app_eval_node_and_pandion_evaluate_agree(tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    pdf = docs / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))

    deps = build_deps(
        artifacts_dir=tmp_path / "artifacts",
        sources_dir=tmp_path / "sources",
        web_dist=tmp_path / "web",
    )
    stored = deps.run_extras()["sources"].add(pdf)
    graph = Graph(
        nodes=[
            Node("src", Stage.SOURCE, "upload", {"sha": stored.sha, "filename": stored.filename}),
            Node("q", Stage.QUERY, "text", {"text": QUESTION, "gold_answer": GOLD, "gold_answers": [GOLD]}),
            Node("parse", Stage.PARSE, "pdfium", {}),
            Node("chunk", Stage.CHUNK, "recursive_character", CHUNK),
            Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
            Node("retrieve", Stage.RETRIEVE, "hybrid_rrf", SEARCH),
            Node("eval", Stage.USE_CASE, "eval", {"top_k": 5}),
        ],
        edges=[
            Edge("src", "parse", "file"),
            Edge("parse", "chunk", "doc"),
            Edge("chunk", "index", "chunks"),
            Edge("index", "retrieve", "index"),
            Edge("retrieve", "eval", "result"),
        ],
    )
    in_app = run(graph, deps.registry, deps.store, context_extras=deps.run_extras())
    assert in_app.ok
    app_payload = Output.model_validate(
        deps.store.load(in_app.nodes["eval"].artifact.id, ArtifactType.OUTPUT)
    ).payload

    p = Pipeline(
        path=tmp_path / "pandion",
        parse="pdfium",
        chunk={"use": "recursive_character", **CHUNK},
        embed="fake-deterministic",
        store="lancedb",
        search={"use": "hybrid_rrf", **SEARCH},
    )
    report = pandion.evaluate(p, [{"question": QUESTION, "gold_answer": GOLD}], documents=docs)

    assert report.questions[0].score == app_payload
    assert app_payload["hit"] is True and app_payload["rank"] == 1
