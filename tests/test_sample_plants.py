"""The two-column report's planted misses stay true.

A sample with planted misses teaches only while each plant misses at the step it
was written for, and its fix finds it. A change elsewhere (a new chunker default,
a different embedder) can quietly break that story, as the lesson data broke after
the MMR fix, so these tests run the sample through the real default pipeline.

The fast half checks the files: page count, the piece count a fast parse gives,
and that every planted question is described in `sample.json`. The slow half,
marked `models`, runs Docling, Qwen3 and the cross-encoder.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import plugins
from core.artifacts import ArtifactType
from core.executor import run
from core.graph import Edge, Graph, Node
from core.ports import Stage
from core.registry import registry
from core.storage import Store
from plugins.chunk import DocView
from plugins.source import upload
from plugins.use_case.eval import _normalise

ROOT = Path(__file__).resolve().parents[1]
NAME = "two-column-report"
FOLDER = ROOT / "samples" / NAME
PDF = FOLDER / f"{NAME}.pdf"
#: The default pipeline's chunker (web/src/state/graph.ts, sampleGraph).
CHUNKER = {"chunk_size": 400, "chunk_overlap": 80}
TOP_K = 5


def _card() -> dict:
    return json.loads((FOLDER / "sample.json").read_text(encoding="utf-8"))


def _questions() -> list[dict]:
    return json.loads((FOLDER / "questions.json").read_text(encoding="utf-8"))


def _designed(questions: list[dict]) -> set[str]:
    return {q["id"] for q in questions if any(t.startswith("designed to miss") for t in q["tags"])}


@pytest.fixture
def sources(tmp_path, monkeypatch):
    plugins.discover()
    folder = tmp_path / "sources"
    folder.mkdir()
    monkeypatch.setattr(upload, "SOURCES_DIR", folder)
    sha = __import__("hashlib").sha256(PDF.read_bytes()).hexdigest()
    (folder / f"{sha}.pdf").write_bytes(PDF.read_bytes())
    return sha, Store(tmp_path / "store")


def _graph(sha: str, *, parser: str = "docling", parse: dict | None = None, rerank: bool = False, question: dict | None = None, through: str = "eval") -> Graph:
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": PDF.name}),
        Node("parse", Stage.PARSE, parser, parse or {}),
        Node("clean", Stage.CLEAN, "dedupe_blocks", {}),
        Node("chunk", Stage.CHUNK, "recursive_character", CHUNKER),
    ]
    edges = [Edge("src", "parse", "file"), Edge("parse", "clean", "doc"), Edge("clean", "chunk", "doc")]
    if through == "chunk":
        return Graph(nodes=nodes, edges=edges)
    golds = [question["gold_answer"], *question.get("gold_answers", [])]
    nodes += [
        Node("index", Stage.INDEX, "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
        Node("ask", Stage.QUERY, "text", {"text": question["question"], "gold_answer": golds[0], "gold_answers": golds}),
        Node("retrieve", Stage.RETRIEVE, "hybrid_rrf", {}),
    ]
    edges += [Edge("chunk", "index", "chunks"), Edge("index", "retrieve", "index")]
    last = "retrieve"
    if rerank:
        nodes.append(Node("rerank", Stage.RERANK, "cross_encoder", {}))
        edges.append(Edge("retrieve", "rerank", "result"))
        last = "rerank"
    nodes.append(Node("eval", Stage.USE_CASE, "eval", {"top_k": TOP_K}))
    edges.append(Edge(last, "eval", "result"))
    return Graph(nodes=nodes, edges=edges)


def _run(store, graph):
    result = run(graph, registry, store)
    assert result.ok, {k: v.error for k, v in result.nodes.items() if v.error}
    return result


def _payload(store, result) -> dict:
    return store.load(result.nodes["eval"].artifact.id, ArtifactType.OUTPUT)["payload"]


def _in_parse(store, result, question) -> bool:
    doc = store.load(result.nodes["parse"].artifact.id, ArtifactType.PARSED_DOC)
    return _normalise(question["gold_answer"]) in _normalise(DocView.of(doc).text)


# ---------------------------------------------------------------- fast ----


def test_the_report_has_five_pages():
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(PDF))
    try:
        assert len(doc) == _card()["pages"] == 5
    finally:
        doc.close()


def test_the_default_chunker_makes_twenty_pieces_or_more(sources):
    """Enough pieces that checking 5 does not find answers by chance (Evaluate's caveat)."""
    sha, store = sources
    result = _run(store, _graph(sha, parser="pdfium", through="chunk"))
    chunks = store.load(result.nodes["chunk"].artifact.id, ArtifactType.CHUNK_SET)["chunks"]
    assert len(chunks) >= 20


def test_every_question_has_an_expected_answer_and_tags():
    for q in _questions():
        assert q["answer"].strip(), q["id"]
        assert q["tags"], q["id"]


def test_two_designed_misses_one_per_side_each_described_in_the_card():
    questions = _questions()
    designed = _designed(questions)
    assert len(designed) == 2
    teaches = {t["question"]: t for t in _card()["teaches"]}
    assert designed <= set(teaches)
    sides = {teaches[q]["lost_at"] for q in designed}
    assert sides == {"parse", "rank"}
    ids = {q["id"] for q in questions}
    for t in teaches.values():
        assert t["question"] in ids
        assert t["why"] and t["fix_text"]


# ---------------------------------------------------------------- slow ----


@pytest.mark.models
def test_the_default_pipeline_finds_every_question_but_the_two_planted(sources):
    sha, store = sources
    questions = _questions()
    designed = _designed(questions)
    for q in questions:
        hit = _payload(store, _run(store, _graph(sha, question=q)))["hit"]
        assert hit is (q["id"] not in designed), q["id"]


@pytest.mark.models
def test_the_footer_plant_is_lost_at_parse_and_found_once_footers_are_read(sources):
    sha, store = sources
    q = next(q for q in _questions() if q["id"] == "fieldwork")
    result = _run(store, _graph(sha, question=q))
    assert not _payload(store, result)["hit"]
    assert not _in_parse(store, result, q)
    fixed = _payload(store, _run(store, _graph(sha, question=q, parse={"content_layers": ["body", "furniture"]})))
    assert fixed["hit"] and fixed["rank"] <= TOP_K


@pytest.mark.models
def test_the_ranking_plant_comes_back_below_the_pieces_checked_and_the_reranker_finds_it(sources):
    sha, store = sources
    q = next(q for q in _questions() if q["id"] == "most-gain")
    missed = _payload(store, _run(store, _graph(sha, question=q)))
    assert not missed["hit"]
    # Returned, but below the pieces checked: a ranking problem, not a lost answer.
    assert missed["found_at"] is not None and missed["found_at"] > TOP_K
    fixed = _payload(store, _run(store, _graph(sha, question=q, rerank=True)))
    assert fixed["hit"]


@pytest.mark.models
def test_the_column_plants_miss_with_fast_text_and_are_found_with_docling(sources):
    sha, store = sources
    for qid in ("lost-place", "extractor-error"):
        q = next(q for q in _questions() if q["id"] == qid)
        result = _run(store, _graph(sha, parser="pdfium", question=q))
        assert not _payload(store, result)["hit"], qid
        assert not _in_parse(store, result, q), qid
