"""Every sample's planted misses stay true.

A sample with planted misses teaches only while each plant misses at the step it
was written for, and its fix finds it. A change elsewhere (a new chunker default,
a different embedder) can quietly break that story, as the lesson data broke after
the MMR fix, so these tests run the samples through the real default pipeline.

The fast half checks the files: page counts, the piece count a fast parse gives,
the tags, and that every planted question is described in `sample.json` under
`teaches`. The slow half, marked `models`, runs Docling, Qwen3, the cross-encoder
and OCR: each question's default result, each plant's lost step, and each fix.
"""

from __future__ import annotations

import hashlib
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
SAMPLES = ["chunking-primer", "two-column-report", "table-of-figures", "scanned-notes"]
#: The text samples: two designed misses each, one per side. Scanned notes is the
#: exception: with no text layer every question misses until OCR is on.
TEXT_SAMPLES = ["chunking-primer", "two-column-report", "table-of-figures"]
SCANNED = "scanned-notes"
#: The default pipeline's chunker (web/src/state/graph.ts, sampleGraph).
CHUNKER = ("recursive_character", {"chunk_size": 400, "chunk_overlap": 80})
TOP_K = 5
MIN_PIECES = 20
INDEX_SIDE = {"parse", "clean", "chunk"}
SEARCH_SIDE = {"rank"}
FAST_TEXT = "misses if you change: Fast text"


def _folder(name: str) -> Path:
    return ROOT / "samples" / name


def _card(name: str) -> dict:
    return json.loads((_folder(name) / "sample.json").read_text(encoding="utf-8"))


def _questions(name: str) -> list[dict]:
    return json.loads((_folder(name) / "questions.json").read_text(encoding="utf-8"))


def _designed(name: str) -> set[str]:
    return {q["id"] for q in _questions(name) if any(t.startswith("designed to miss") for t in q["tags"])}


def _golds(q: dict) -> list[str]:
    return [q["gold_answer"], *q.get("gold_answers", [])]


def _has(text: str, q: dict) -> bool:
    folded = _normalise(text)
    return any(_normalise(g) in folded for g in _golds(q))


class Runner:
    """One sample in a fresh store, run through the real pipeline in-process."""

    def __init__(self, name: str, tmp_path: Path, monkeypatch) -> None:
        plugins.discover()
        folder = tmp_path / "sources"
        folder.mkdir()
        monkeypatch.setattr(upload, "SOURCES_DIR", folder)
        self.pdf = _folder(name) / f"{name}.pdf"
        self.sha = hashlib.sha256(self.pdf.read_bytes()).hexdigest()
        (folder / f"{self.sha}.pdf").write_bytes(self.pdf.read_bytes())
        self.store = Store(tmp_path / "store")

    def graph(self, q: dict | None = None, *, parser="docling", parse=None, chunker=CHUNKER, retrieve=None, rerank=False, through="eval") -> Graph:
        nodes = [
            Node("src", Stage.SOURCE, "upload", {"sha": self.sha, "filename": self.pdf.name}),
            Node("parse", Stage.PARSE, parser, parse or {}),
            Node("clean", Stage.CLEAN, "dedupe_blocks", {}),
            Node("chunk", Stage.CHUNK, chunker[0], chunker[1]),
        ]
        edges = [Edge("src", "parse", "file"), Edge("parse", "clean", "doc"), Edge("clean", "chunk", "doc")]
        if through == "chunk":
            return Graph(nodes=nodes, edges=edges)
        golds = _golds(q)
        nodes += [
            Node("index", Stage.INDEX, "lancedb", {"embedder": "qwen3-embedding-0.6b"}),
            Node("ask", Stage.QUERY, "text", {"text": q["question"], "gold_answer": golds[0], "gold_answers": golds}),
            Node("retrieve", Stage.RETRIEVE, "hybrid_rrf", retrieve or {}),
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

    def run(self, graph: Graph):
        result = run(graph, registry, self.store)
        assert result.ok, {k: v.error for k, v in result.nodes.items() if v.error}
        return result

    def load(self, result, node: str, kind: ArtifactType):
        return self.store.load(result.nodes[node].artifact.id, kind)

    def ask(self, q: dict, **kw) -> tuple[dict, object]:
        result = self.run(self.graph(q, **kw))
        return self.load(result, "eval", ArtifactType.OUTPUT)["payload"], result

    def pieces(self, result) -> list[dict]:
        return self.load(result, "chunk", ArtifactType.CHUNK_SET)["chunks"]

    def lost_at(self, q: dict, result) -> str:
        """The first step the evidence is gone from, the way the miss trace walks it."""
        if not _has(DocView.of(self.load(result, "parse", ArtifactType.PARSED_DOC)).text, q):
            return "parse"
        if not _has(DocView.of(self.load(result, "clean", ArtifactType.PARSED_DOC)).text, q):
            return "clean"
        if not any(_has(c["text"], q) for c in self.pieces(result)):
            return "chunk"
        return "rank"


def _fix_kwargs(fix: dict) -> dict:
    """A `teaches` fix as the change it makes to the default pipeline."""
    stage, config = fix["stage"], fix.get("config", {})
    if stage == "parse":
        return {"parse": config}
    if stage == "chunk":
        return {"chunker": (fix["transform"], config)}
    if stage == "retrieve":
        return {"retrieve": config}
    if stage == "rerank":
        return {"rerank": True}
    raise AssertionError(f"no way to apply a fix at {stage}")


# ---------------------------------------------------------------- fast ----


@pytest.mark.parametrize("name", SAMPLES)
def test_the_card_states_the_real_page_count(name):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(_folder(name) / f"{name}.pdf"))
    try:
        assert len(doc) == _card(name)["pages"]
    finally:
        doc.close()


@pytest.mark.parametrize("name", TEXT_SAMPLES)
def test_a_fast_parse_and_the_default_chunker_make_twenty_pieces_or_more(name, tmp_path, monkeypatch):
    """Enough pieces that checking 5 does not find answers by chance (Evaluate's caveat)."""
    runner = Runner(name, tmp_path, monkeypatch)
    result = runner.run(runner.graph(parser="pdfium", through="chunk"))
    assert len(runner.pieces(result)) >= MIN_PIECES


@pytest.mark.parametrize("name", SAMPLES)
def test_every_question_has_an_expected_answer_and_tags(name):
    for q in _questions(name):
        assert q["answer"].strip(), q["id"]
        assert q["tags"], q["id"]


@pytest.mark.parametrize("name", TEXT_SAMPLES)
def test_two_designed_misses_one_per_side_each_described_in_the_card(name):
    designed = _designed(name)
    assert len(designed) == 2
    teaches = {t["question"]: t for t in _card(name)["teaches"]}
    assert designed <= set(teaches)
    sides = [teaches[q]["lost_at"] for q in designed]
    assert sum(s in INDEX_SIDE for s in sides) == 1
    assert sum(s in SEARCH_SIDE for s in sides) == 1
    ids = {q["id"] for q in _questions(name)}
    for t in teaches.values():
        assert t["question"] in ids
        assert t["why"] and t["fix_text"]


def test_every_scanned_question_is_planted_to_miss_without_a_text_layer():
    assert _designed(SCANNED) == {q["id"] for q in _questions(SCANNED)}
    for q in _questions(SCANNED):
        assert "designed to miss: no text layer" in q["tags"]
    (teach,) = _card(SCANNED)["teaches"]
    assert teach["question"] == "*" and teach["lost_at"] == "parse"


# ---------------------------------------------------------------- slow ----


@pytest.mark.models
@pytest.mark.parametrize("name", TEXT_SAMPLES)
def test_the_default_pipeline_finds_every_question_but_the_two_planted(name, tmp_path, monkeypatch):
    runner = Runner(name, tmp_path, monkeypatch)
    designed = _designed(name)
    for q in _questions(name):
        payload, result = runner.ask(q)
        assert payload["hit"] is (q["id"] not in designed), q["id"]
        assert len(runner.pieces(result)) >= MIN_PIECES


@pytest.mark.models
@pytest.mark.parametrize("name", TEXT_SAMPLES)
def test_each_plant_is_lost_at_its_step_and_its_fix_finds_it(name, tmp_path, monkeypatch):
    runner = Runner(name, tmp_path, monkeypatch)
    questions = {q["id"]: q for q in _questions(name)}
    for teach in _card(name)["teaches"]:
        if teach["kind"] != "designed to miss":
            continue
        q = questions[teach["question"]]
        payload, result = runner.ask(q)
        assert not payload["hit"], q["id"]
        assert runner.lost_at(q, result) == teach["lost_at"], q["id"]
        fixed, _ = runner.ask(q, **_fix_kwargs(teach["fix"]))
        assert fixed["hit"], (q["id"], teach["fix"])


@pytest.mark.models
@pytest.mark.parametrize("name", TEXT_SAMPLES)
def test_questions_tagged_fast_text_miss_at_parse_with_fast_text(name, tmp_path, monkeypatch):
    runner = Runner(name, tmp_path, monkeypatch)
    for q in _questions(name):
        if FAST_TEXT not in q["tags"]:
            continue
        payload, result = runner.ask(q, parser="pdfium")
        assert not payload["hit"], q["id"]
        assert runner.lost_at(q, result) == "parse", q["id"]


@pytest.mark.models
def test_scanned_notes_misses_everything_without_ocr_and_finds_everything_with_it(tmp_path, monkeypatch):
    runner = Runner(SCANNED, tmp_path, monkeypatch)
    (teach,) = _card(SCANNED)["teaches"]
    for q in _questions(SCANNED):
        payload, result = runner.ask(q)
        assert not payload["hit"], q["id"]
        assert runner.lost_at(q, result) == "parse", q["id"]
        fixed, result = runner.ask(q, **_fix_kwargs(teach["fix"]))
        assert fixed["hit"], q["id"]
        assert len(runner.pieces(result)) >= MIN_PIECES
