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

import pandion.plugins
from pandion.artifacts import ArtifactType
from pandion.executor import run
from pandion.graph import Edge, Graph, Node
from pandion.ports import Stage
from pandion.registry import registry
from pandion.storage import Store
from pandion.plugins.chunk import DocView
from pandion.embedding_cache import EmbeddingCache
from pandion.models import ModelSettings
from pandion.sources import Sources
from pandion.textmatch import normalise as _normalise

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ["chunking-primer", "two-column-report", "table-of-figures", "scanned-notes", "station-manual"]
#: The text samples: two designed misses each, one per side. Scanned notes is the
#: exception: with no text layer every question misses until OCR is on.
TEXT_SAMPLES = ["chunking-primer", "two-column-report", "table-of-figures"]
SCANNED = "scanned-notes"
#: The sample of Pandion's "Manuals and guides" template. It plants no misses:
#: every question is meant to be found by that template's pipeline.
MANUAL = "station-manual"
#: The default pipeline's chunker (playground/frontend/src/state/graph.ts, sampleGraph).
CHUNKER = ("recursive_character", {"chunk_size": 400, "chunk_overlap": 80})
TOP_K = 5
MIN_PIECES = 20
#: The margins that keep a result the same on Windows and on Linux, where the
#: embedder and Docling's layout model can move a passage a place or two: an
#: ordinary question is found in the top 3, not just the top 5, a search-side
#: plant comes back 10th or lower (or not at all), and every fix finds its plant
#: in the top 3.
FOUND_BY = 3
MISSED_FROM = 10
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
        pandion.plugins.discover()
        folder = tmp_path / "sources"
        folder.mkdir()
        self.extras = {
            "sources": Sources(folder),
            "embedding_cache": EmbeddingCache(tmp_path / "embcache"),
            "models": ModelSettings(device="cpu"),
        }
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
        result = run(graph, registry, self.store, context_extras=self.extras)
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


#: Shorter than this, a paragraph's last line is a fragment. On the Space,
#: Docling's layout model moved three such fragments from page 3 of the primer
#: into one block of their own, so a sentence that ended on one was cut in two.
SHORT_LINE = 45


@pytest.mark.parametrize("name", [*TEXT_SAMPLES, MANUAL])
def test_no_answer_to_be_found_ends_on_a_short_last_line(name):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(_folder(name) / f"{name}.pdf"))
    try:
        lines = [" ".join(line.split()) for page in doc for line in page.get_textpage().get_text_range().splitlines()]
    finally:
        doc.close()
    short = [line for line in lines if 0 < len(line) < SHORT_LINE]
    designed = _designed(name)
    for q in _questions(name):
        if q["id"] in designed:
            continue
        for gold in q.get("gold_answers") or [q["gold_answer"]]:
            gold = " ".join(gold.split())
            # A table cell is its own short line on purpose; only a sentence's tail is at risk.
            tails = [line for line in short if gold.endswith(line) and " " in line and len(line) < len(gold)]
            assert not tails, f"{q['id']} ends on the short line {tails[0]!r}"


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
        if payload["hit"]:
            assert payload["rank"] <= FOUND_BY, (q["id"], payload["rank"])
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
        if teach["lost_at"] in SEARCH_SIDE and payload["found_at"] is not None:
            assert payload["found_at"] >= MISSED_FROM, (q["id"], payload["found_at"])
        fixed, _ = runner.ask(q, **_fix_kwargs(teach["fix"]))
        assert fixed["hit"], (q["id"], teach["fix"])
        assert fixed["rank"] <= FOUND_BY, (q["id"], fixed["rank"])


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
        assert fixed["rank"] <= FOUND_BY, (q["id"], fixed["rank"])
        assert len(runner.pieces(result)) >= MIN_PIECES
