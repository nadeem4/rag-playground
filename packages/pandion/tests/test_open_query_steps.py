"""Any rewrite and any answer strategy, and the document only for a step that asks for it.

Two small PDFs and the fake embedder, so nothing reaches the network. A rewrite or
answer step is given the parsed document only when its class declares a `doc` input.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel

from pandion import Pipeline
from pandion.config import ConfigError, from_dict, to_dict
from pandion.extend import (
    ArtifactType, Output, ParsedDoc, PortSpec, Query, RetrievalResult, Stage, Transform, register,
)
from pandion.registry import registry
from pdfs import SAMPLE_PAGES, build_pdf

QUESTION = "What is the capital of France?"


class RewriteSettings(BaseModel):
    text: str = ""


class Upper(Transform[RewriteSettings]):
    """Reads the question from its `text` setting, as the built-in rewrites do."""

    name = "test_upper"
    stage = Stage.QUERY
    inputs = {}
    output = ArtifactType.QUERY
    config_model = RewriteSettings
    summary = "Asks the question in capitals."

    def apply(self, inputs, config, ctx):
        return Query(text=config.text.upper())


class NoSettings(BaseModel):
    pass


class Bullets(Transform[NoSettings]):
    name = "test_bullets"
    stage = Stage.USE_CASE
    inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
    output = ArtifactType.OUTPUT
    config_model = NoSettings
    summary = "The pieces found, as a bulleted list."

    def apply(self, inputs, config, ctx):
        result = RetrievalResult.model_validate(inputs["result"])
        lines = [f"- {hit.chunk.text}" for hit in result.hits]
        return Output(kind="text", payload={"text": "\n".join(lines)})


class DocAnswer(Transform[NoSettings]):
    name = "test_doc_answer"
    stage = Stage.USE_CASE
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        "doc": PortSpec(ArtifactType.PARSED_DOC),
    }
    output = ArtifactType.OUTPUT
    config_model = NoSettings
    summary = "Answers with the document's first block."

    def apply(self, inputs, config, ctx):
        doc = ParsedDoc.model_validate(inputs["doc"])
        return Output(kind="text", payload={"text": doc.elements[0].text})


STRATEGIES = (Upper, Bullets, DocAnswer)


@pytest.fixture(autouse=True, scope="module")
def _strategies():
    """Register the test strategies for this file only, so no other test sees them."""
    from pandion.plugins import discover

    discover()
    for cls in STRATEGIES:
        register(cls)
    yield
    for cls in STRATEGIES:
        registry._by_stage[cls.stage].pop(cls.name, None)


@pytest.fixture
def pdf(tmp_path) -> Path:
    """A folder with two small PDFs. The first by name is guides/short.pdf."""
    docs = tmp_path / "docs"
    (docs / "guides").mkdir(parents=True)
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "guides" / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return docs


def _config(**parts) -> dict:
    retrieve = {"search": {"use": "hybrid_rrf", "top_k": 3}}
    if "rewrite" in parts:
        retrieve["rewrite"] = parts["rewrite"]
    config = {
        "path": "./index",
        "models": {"device": "cpu"},
        "index": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
            "embed": {"use": "fake-deterministic"},
            "store": {"use": "lancedb"},
        },
        "retrieve": retrieve,
    }
    if "answer" in parts:
        config["answer"] = parts["answer"]
    return config


def _built(tmp_path: Path, docs: Path, **parts) -> Pipeline:
    p = Pipeline._of(from_dict(_config(**parts), base=tmp_path))
    assert p.index.run(docs).ok
    return p


def test_a_custom_rewrite_without_a_doc_input_runs(tmp_path, pdf):
    p = _built(tmp_path, pdf, rewrite={"use": "test_upper"})

    graph, _ = p.retrieval.graph(QUESTION)
    assert not [e for e in graph.edges if e.dst == "rewrite"]

    result = p.retrieve(QUESTION)
    assert result.ok
    assert result.stages["rewrite"].output.text == QUESTION.upper()
    assert result.hits


def test_a_custom_answer_is_accepted_and_its_text_is_read(tmp_path, pdf):
    p = _built(tmp_path, pdf, answer={"use": "test_bullets"})

    answer = p.ask(QUESTION)

    assert answer.ok
    assert answer.output.kind == "text"
    assert answer.text.startswith("- ")
    assert answer.text == "\n".join(f"- {hit.chunk.text}" for hit in answer.hits)


def test_an_answer_that_declares_doc_gets_the_document(tmp_path, pdf):
    p = _built(tmp_path, pdf, answer={"use": "test_doc_answer"})

    answer = p.ask(QUESTION)

    assert answer.ok
    assert answer.text == "Paris is the capital of France."


def test_an_answer_without_a_doc_input_gets_no_doc_edge(tmp_path, pdf):
    p = _built(tmp_path, pdf, answer={"use": "test_bullets"})

    graph, _ = p.query.graph(QUESTION)

    assert [e.port for e in graph.edges if e.dst == "answer"] == ["result"]


def test_eval_is_not_an_answer_step(tmp_path):
    with pytest.raises(ConfigError, match="eval"):
        from_dict(_config(answer={"use": "eval"}), base=tmp_path)


def test_a_pipeline_with_custom_steps_round_trips(tmp_path):
    c = from_dict(
        _config(rewrite={"use": "test_upper"}, answer={"use": "test_bullets"}), base=tmp_path
    )
    assert from_dict(to_dict(c), base=tmp_path) == c
