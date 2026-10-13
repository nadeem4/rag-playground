"""Checks the installed pandion wheel, run by run_check.py in a new environment.

It needs two environment variables: PANDION_CHECK_VENV, the new environment's
folder, and PANDION_CHECK_SAMPLES, the sample PDFs joined with os.pathsep.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import pandion
from pandion import Pipeline
from pandion.answer import Search
from pandion.chunk import RecursiveCharacter
from pandion.clean import DedupeBlocks
from pandion.parse import Pdfium
from pandion.retrieve import HybridRrf

VENV = Path(os.environ["PANDION_CHECK_VENV"]).resolve()
FILES = [Path(p) for p in os.environ["PANDION_CHECK_SAMPLES"].split(os.pathsep)]
QUESTION = "How big should a chunk be?"

YAML = """\
path: ./index
models:
  device: cpu
index:
  parse: {use: pdfium}
  clean:
    - use: dedupe_blocks
  chunk: {use: recursive_character, chunk_size: 400, chunk_overlap: 40}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
retrieve:
  search: {use: hybrid_rrf, top_k: 20}
answer: {use: search, top_k: 3}
"""


def from_yaml(root: Path) -> Pipeline:
    root.mkdir(parents=True, exist_ok=True)
    (root / "pipeline.yaml").write_text(YAML, encoding="utf-8")
    return Pipeline.from_yaml(root / "pipeline.yaml")


def from_dicts(root: Path) -> Pipeline:
    return Pipeline(
        path=root / "index",
        models={"device": "cpu"},
        parse={"use": "pdfium"},
        clean=[{"use": "dedupe_blocks"}],
        chunk={"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 40},
        embed={"use": "fake-deterministic"},
        store={"use": "lancedb"},
        search={"use": "hybrid_rrf", "top_k": 20},
        answer={"use": "search", "top_k": 3},
    )


def from_classes(root: Path) -> Pipeline:
    return Pipeline(
        path=root / "index",
        models={"device": "cpu"},
        parse=Pdfium(),
        clean=[DedupeBlocks()],
        chunk=RecursiveCharacter(chunk_size=400, chunk_overlap=40),
        embed="fake-deterministic",
        store="lancedb",
        search=HybridRrf(top_k=20),
        answer=Search(top_k=3),
    )


STYLES = {"yaml": from_yaml, "dicts": from_dicts, "classes": from_classes}


def nodes(graph) -> tuple[list, list]:
    """A graph without its folder: every node and edge, in order."""
    return [(n.id, n.stage, n.transform, n.config) for n in graph.nodes], list(graph.edges)


def summary(p: Pipeline) -> dict:
    """Index, retrieve and ask with `p`, and keep what must match across styles."""
    report = p.index.run(FILES)
    result = p.retrieve(QUESTION)
    answer = p.ask(QUESTION)
    assert report.ok and result.ok and answer.ok
    return {
        "index_graph": nodes(p.index.graph(p.index.documents)[0]),
        "query_graph": nodes(p.query.graph(QUESTION)[0]),
        "index_ids": {
            doc: {stage: r.artifact_id for stage, r in d.stages.items()} for doc, d in report.documents.items()
        },
        "index_id": report.index.artifact_id,
        "retrieve_ids": [result.stages[s].artifact_id for s in ("rewrite", "search")],
        "hits": [(h.chunk.id, h.rank, h.score) for h in result.hits],
        "ask_ids": [answer.stages[s].artifact_id for s in ("rewrite", "search", "answer")],
        "answer": answer.output,
    }


def test_pandion_comes_from_the_new_environment():
    assert Path(pandion.__file__).resolve().is_relative_to(VENV)


def test_the_three_styles_give_the_same_graphs_ids_and_results(tmp_path):
    runs = {name: summary(build(tmp_path / name)) for name, build in STYLES.items()}
    assert runs["yaml"] == runs["dicts"] == runs["classes"]
    assert runs["yaml"]["hits"]
    assert len(runs["yaml"]["index_ids"]) == len(FILES)


@pytest.mark.parametrize("style", STYLES)
def test_to_yaml_round_trip_gives_the_same_ids(tmp_path, style):
    p = STYLES[style](tmp_path / "code")
    (tmp_path / "file").mkdir()
    p.to_yaml(tmp_path / "file" / "pipeline.yaml")
    again = Pipeline.from_yaml(tmp_path / "file" / "pipeline.yaml")
    first, second = summary(p), summary(again)
    for key in ("index_graph", "query_graph", "index_ids", "index_id", "retrieve_ids", "hits", "ask_ids"):
        assert first[key] == second[key], key


def test_single_stage_calls_work():
    parsed = pandion.parse(FILES[0], use="pdfium")
    assert parsed.output.page_count > 0 and parsed.output.elements
    cleaned = pandion.clean(parsed, steps=[{"use": "dedupe_blocks"}])
    chunks = pandion.chunk(cleaned, use="recursive_character", chunk_size=400)
    assert chunks.output.chunks and chunks.output.chunks[0].text


def test_a_second_index_run_is_all_cache_hits(tmp_path):
    p = from_yaml(tmp_path)
    first = p.index.run(FILES)
    second = p.index.run(FILES)
    assert first.ok and second.ok
    statuses = [r.status for d in second.documents.values() for r in d.stages.values()]
    statuses.append(second.index.status)
    assert statuses and set(statuses) == {"cached"}
