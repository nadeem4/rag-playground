"""p.ask(question): retrieval, then the answer step.

Two small PDFs, the fake embedder (no download) and a fake chat model, so
nothing reaches the network. The answer step is `search` (the found pieces as
they are) or `chat` (an answer whose claims cite the pieces).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pandion import Answer, Pipeline, QueryPipeline
from pandion import llm
from pandion.cli import extras_for
from pandion.config import ConfigError
from pandion.llm import Completion
from pandion.payloads import Output, RetrievalResult
from pdfs import SAMPLE_PAGES, build_pdf

QUESTION = "What is the capital of France?"

INDEX = """\
path: ./index
models:
  device: cpu
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character, chunk_size: 70, chunk_overlap: 10}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
retrieve:
  search: {use: bm25, top_k: 4}
"""


def write(tmp_path: Path, answer: str) -> Path:
    config = tmp_path / "pipeline.yaml"
    config.write_text(INDEX + answer, encoding="utf-8")
    docs = tmp_path / "docs"
    (docs / "guides").mkdir(parents=True)
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "guides" / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return config


def built(tmp_path: Path, answer: str) -> Pipeline:
    config = write(tmp_path, answer)
    p = Pipeline.from_yaml(config)
    assert p.index.run(config.parent / "docs").ok
    return p


@pytest.fixture
def chat_model(monkeypatch):
    """A chat model that cites the first sentence of the first piece."""
    calls: list[dict] = []

    def complete(model, **kwargs):
        calls.append({"model": model.id, **kwargs})
        return Completion(
            text="Paris is the capital of France [1.1].", usage={}, stop_reason="end_turn"
        )

    monkeypatch.setattr(llm, "complete", complete)
    return calls


def test_ask_with_search_shows_the_pieces_retrieval_found(tmp_path):
    p = built(tmp_path, "answer: {use: search, top_k: 2}\n")

    answer = p.ask(QUESTION)

    assert isinstance(answer, Answer) and answer.ok
    assert isinstance(answer.output, Output) and answer.output.kind == "search"
    rows = answer.output.payload["results"]
    assert len(rows) == 2
    assert [r["chunk_id"] for r in rows] == [h.chunk.id for h in answer.hits[:2]]
    assert "Paris is the capital of France." in answer.text


def test_every_stage_of_an_ask_can_be_inspected(tmp_path):
    p = built(tmp_path, "answer: {use: search}\n")

    answer = p.ask(QUESTION)

    stages = answer.stages
    assert stages["rewrite"].transform == "text"
    assert stages["search"].transform == "bm25"
    assert isinstance(stages["search"].output, RetrievalResult)
    assert stages["rerank"] == []
    assert stages["answer"].transform == "search" and stages["answer"].stage == "answer"
    assert stages["answer"].output == answer.output
    assert all(stages[s].status == "executed" and stages[s].artifact_id for s in ("rewrite", "search", "answer"))
    assert answer.index.status == "cached"
    assert answer.retrieval.hits == answer.hits


def test_asking_again_with_search_is_all_cache_hits(tmp_path):
    p = built(tmp_path, "answer: {use: search}\n")
    first = p.ask(QUESTION)

    second = p.ask(QUESTION)

    assert second.stages["answer"].status == "cached"
    assert second.stages["answer"].artifact_id == first.stages["answer"].artifact_id
    assert second.output == first.output


def test_ask_with_chat_answers_with_citations(tmp_path, chat_model):
    p = built(tmp_path, "answer: {use: chat, model: gpt-6-astra}\n")

    answer = p.ask(QUESTION, credentials={"openai_api_key": "sk-test"})

    assert answer.ok, answer.stages["answer"].error
    assert answer.output.kind == "chat"
    assert answer.text == "Paris is the capital of France."
    citation = answer.output.payload["citations"][0]
    assert citation["cited_text"] == "Paris is the capital of France."
    assert [c["api_key"] for c in chat_model] == ["sk-test"]
    assert chat_model[0]["public_only"] is False
    assert QUESTION in chat_model[0]["user"]


def test_a_chat_answer_is_never_cached(tmp_path, chat_model):
    p = built(tmp_path, "answer: {use: chat, model: gpt-6-astra}\n")
    creds = {"openai_api_key": "sk-test"}

    p.ask(QUESTION, credentials=creds)
    again = p.ask(QUESTION, credentials=creds)

    assert again.stages["answer"].status == "executed"
    assert again.stages["search"].status == "cached"
    assert len(chat_model) == 2


def test_a_missing_key_is_reported_on_the_answer_step(tmp_path):
    p = built(tmp_path, "answer: {use: chat, model: gpt-6-astra}\n")

    answer = p.ask(QUESTION)

    assert not answer.ok
    assert answer.stages["answer"].status == "failed"
    assert "API key" in answer.stages["answer"].error
    assert answer.output is None and answer.text == ""
    assert answer.hits  # retrieval still worked


def test_k_sets_how_many_hits_reach_the_answer(tmp_path):
    p = built(tmp_path, "answer: {use: search, top_k: 10}\n")

    assert len(p.ask(QUESTION, k=1).output.payload["results"]) == 1


def test_the_query_part_can_be_used_on_its_own(tmp_path):
    config = write(tmp_path, "answer: {use: search}\n")
    query = QueryPipeline.from_yaml(config)
    query.index.run(tmp_path / "docs")

    answer = query.ask(QUESTION)

    assert answer.ok and answer.output.kind == "search"
    assert "Paris is the capital of France." in answer.text


@pytest.mark.parametrize(
    "answer,named",
    [
        ("answer: {use: search, top_n: 3}\n", "answer (search) has no setting 'top_n'"),
        ("answer: {use: eval}\n", "answer uses 'eval'"),
        ("answer: search\n", "answer must say which strategy to use"),
    ],
)
def test_a_wrong_answer_step_names_the_stage(tmp_path, answer, named):
    with pytest.raises(ConfigError, match=named.replace("(", r"\(").replace(")", r"\)")):
        Pipeline.from_yaml(write(tmp_path, answer))


def test_an_answer_needs_a_retrieve_section(tmp_path):
    config = tmp_path / "pipeline.yaml"
    config.write_text(INDEX.split("retrieve:")[0] + "answer: {use: search}\n", encoding="utf-8")

    with pytest.raises(ConfigError, match="answer needs a retrieve section"):
        Pipeline.from_yaml(config)


def test_a_file_without_an_answer_section_cannot_ask(tmp_path):
    p = built(tmp_path, "")

    with pytest.raises(ValueError, match="no answer section"):
        p.ask(QUESTION)


def test_from_file_still_reads_a_pipeline(tmp_path):
    config = write(tmp_path, "answer: {use: search}\n")

    assert Pipeline.from_file(config).config == Pipeline.from_yaml(config).config


def test_install_adds_the_sdk_the_chat_model_needs(tmp_path):
    claude = Pipeline.from_yaml(write(tmp_path, "answer: {use: chat}\n")).config
    (tmp_path / "pipeline.yaml").write_text(INDEX + "answer: {use: chat, model: gpt-6-astra}\n")
    openai = Pipeline.from_yaml(tmp_path / "pipeline.yaml").config

    assert "anthropic" in extras_for(claude)
    assert "openai" in extras_for(openai) and "anthropic" not in extras_for(openai)
