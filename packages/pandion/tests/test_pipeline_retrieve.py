"""p.retrieve(question, k=...): search the index the pipeline built.

Two small PDFs, the fake embedder (no download), a fake cross-encoder and a
fake chat model, so nothing reaches the network. Retrieval runs through the
executor and the store, so asking the same question twice only reads what is
stored, and every stage can be inspected.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import pandion.plugins.rerank.cross_encoder as ce
from pandion import Pipeline
from pandion import llm
from pandion.config import ConfigError
from pandion.llm import Completion
from pandion.payloads import Query, RetrievalResult
from pdfs import SAMPLE_PAGES, build_pdf

QUESTION = "What is the capital of France?"

INDEX = """\
path: ./index
models:
  device: cpu
index:
  parse:
    use: pdfium
  chunk:
    use: recursive_character
    chunk_size: 70
    chunk_overlap: 10
  embed:
    use: fake-deterministic
  store:
    use: lancedb
"""

RETRIEVE = """\
retrieve:
  search:
    use: hybrid_rrf
    top_k: 5
  rerank:
    - use: mmr
      top_k: 4
      lambda_mult: 0.5
    - use: cross_encoder
      top_k: 3
"""


class FakeCrossEncoder:
    """Scores a pair by how many of the question's words the piece holds."""

    def predict(self, pairs):
        return [
            float(sum(word in text.lower() for word in question.lower().split()))
            for question, text in pairs
        ]


@pytest.fixture(autouse=True)
def fake_cross_encoder(monkeypatch):
    loaded: list = []

    def load(model_id, settings=None):
        loaded.append((model_id, settings))
        return FakeCrossEncoder()

    monkeypatch.setattr(ce, "_load", load)
    return loaded


def write(tmp_path: Path, retrieve: str = RETRIEVE) -> Path:
    config = tmp_path / "pipeline.yaml"
    config.write_text(INDEX + retrieve, encoding="utf-8")
    docs = tmp_path / "docs"
    (docs / "guides").mkdir(parents=True)
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "guides" / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return config


def built(tmp_path: Path, retrieve: str = RETRIEVE) -> Pipeline:
    config = write(tmp_path, retrieve)
    p = Pipeline.from_file(config)
    assert p.index.run(config.parent / "docs").ok
    return p


def test_retrieve_finds_the_piece_that_answers(tmp_path):
    p = built(tmp_path)

    result = p.retrieve(QUESTION)

    assert result.ok
    assert isinstance(result.result, RetrievalResult)
    assert len(result.hits) == 3
    assert [h.rank for h in result.hits] == [1, 2, 3]
    assert "Paris is the capital of France." in result.hits[0].chunk.text


def test_every_stage_can_be_inspected(tmp_path, fake_cross_encoder):
    p = built(tmp_path)

    result = p.retrieve(QUESTION)

    rewrite, search = result.stages["rewrite"], result.stages["search"]
    assert rewrite.transform == "text" and isinstance(rewrite.output, Query)
    assert rewrite.output.text == QUESTION
    assert search.transform == "hybrid_rrf" and len(search.output.hits) == 5
    assert [s.transform for s in result.stages["rerank"]] == ["mmr", "cross_encoder"]
    assert [len(s.output.hits) for s in result.stages["rerank"]] == [4, 3]
    assert result.stages["rerank"][-1].output == result.result
    assert result.stages["rerank"][1].note.startswith("Scored 4 candidates")
    assert result.index.transform == "lancedb" and result.index.status == "cached"
    stages = [rewrite, search, *result.stages["rerank"]]
    assert all(s.status == "executed" and s.artifact_id for s in stages)
    # The run's model settings reach the cross-encoder.
    assert fake_cross_encoder[0][1].device == "cpu"


def test_asking_again_is_all_cache_hits(tmp_path):
    p = built(tmp_path)
    first = p.retrieve(QUESTION)

    again = Pipeline.from_file(tmp_path / "pipeline.yaml")
    with pytest.raises(ValueError, match="index some files first"):
        again.retrieve(QUESTION)
    second = p.retrieve(QUESTION)

    stages = [second.stages["rewrite"], second.stages["search"], *second.stages["rerank"]]
    assert all(s.status == "cached" for s in stages)
    assert [h.chunk.id for h in second.hits] == [h.chunk.id for h in first.hits]


def test_a_new_process_finds_the_index_a_sync_built(tmp_path):
    config = write(tmp_path)
    Pipeline.from_file(config).index.sync(tmp_path / "docs")

    result = Pipeline.from_file(config).retrieve(QUESTION)

    assert result.ok and result.index.status == "cached"
    assert "Paris is the capital of France." in result.hits[0].chunk.text


def test_k_sets_how_many_hits_the_last_step_keeps(tmp_path):
    p = built(tmp_path)

    assert len(p.retrieve(QUESTION, k=2).hits) == 2
    assert p.retrieve(QUESTION, k=2).stages["rerank"][-1].status == "cached"


def test_without_a_reranker_the_search_is_the_result(tmp_path):
    p = built(tmp_path, "retrieve:\n  rewrite: none\n  search:\n    use: bm25\n    top_k: 4\n")

    result = p.retrieve(QUESTION, k=2)

    assert result.stages["rerank"] == []
    assert result.result == result.stages["search"].output
    assert len(result.hits) == 2


def test_one_reranker_may_be_given_without_a_list(tmp_path):
    p = built(tmp_path, "retrieve:\n  search: {use: dense}\n  rerank: {use: mmr, top_k: 2}\n")

    assert [s.transform for s in p.retrieve(QUESTION).stages["rerank"]] == ["mmr"]


def test_llm_rewrite_and_llm_rerank_take_the_key_from_credentials(tmp_path, monkeypatch):
    calls: list[dict] = []

    def complete(model, **kwargs):
        calls.append(kwargs)
        text = "capital France Paris" if "search words" in kwargs["system"] else "2, 1"
        return Completion(text=text, usage={}, stop_reason="end_turn")

    monkeypatch.setattr(llm, "complete", complete)
    p = built(
        tmp_path,
        "retrieve:\n"
        "  rewrite: {use: llm_rewrite, style: keywords}\n"
        "  search: {use: bm25, top_k: 4}\n"
        "  rerank: {use: llm_rerank, top_k: 2}\n",
    )

    result = p.retrieve(QUESTION, credentials={"anthropic_api_key": "sk-ant-test"})

    assert result.ok, [s.error for s in result.stages.values() if hasattr(s, "error")]
    assert result.stages["rewrite"].output.text == "capital France Paris"
    assert result.stages["rewrite"].output.original == QUESTION
    assert [c["api_key"] for c in calls] == ["sk-ant-test", "sk-ant-test"]
    assert all(c["public_only"] is False for c in calls)
    assert len(result.hits) == 2


def test_a_missing_key_is_reported_on_its_stage(tmp_path):
    p = built(tmp_path, "retrieve:\n  search: {use: bm25}\n  rerank: {use: llm_rerank}\n")

    result = p.retrieve(QUESTION)

    assert not result.ok
    failed = result.stages["rerank"][0]
    assert failed.status == "failed" and "API key" in failed.error
    assert result.hits == []


@pytest.mark.parametrize(
    "retrieve,named",
    [
        ("retrieve:\n  search: {use: dense, top_n: 3}\n", "retrieve.search (dense) has no setting 'top_n'"),
        ("retrieve:\n  search: {use: dense}\n  rerank: [{use: mmr}, {use: cross_encoder, lambda_mult: 1}]\n",
         "retrieve.rerank step 2 (cross_encoder) has no setting 'lambda_mult'"),
        ("retrieve:\n  rewrite: {use: llm_rewrite, temperature: 0}\n  search: {use: dense}\n",
         "retrieve.rewrite (llm_rewrite) has no setting 'temperature'"),
        ("retrieve:\n  search: {use: nearest}\n", "retrieve.search uses 'nearest'"),
        ("retrieve:\n  rerank: {use: mmr}\n", "retrieve has no search step"),
        ("retrieve:\n  search: {use: dense}\n  filter: {}\n", "retrieve has no setting 'filter'"),
        ("retrieve:\n  rewrite: {use: llm_rewrite, text: hi}\n  search: {use: dense}\n",
         "retrieve.rewrite sets text"),
    ],
)
def test_an_unknown_setting_names_the_stage(tmp_path, retrieve, named):
    with pytest.raises(ConfigError, match=named.replace("(", r"\(").replace(")", r"\)")):
        Pipeline.from_file(write(tmp_path, retrieve))


def test_a_file_without_a_retrieve_section_cannot_retrieve(tmp_path):
    p = built(tmp_path, "")

    with pytest.raises(ValueError, match="no retrieve section.*Add a retrieve section with at least a search step"):
        p.retrieve(QUESTION)
