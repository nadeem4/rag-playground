"""Contract tests for the cross-encoder reranker.

No test downloads a model: a fake is injected through the module's loader, so
the scores are whatever the test says they are and the ordering is exact.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import plugins.rerank.cross_encoder as ce
from api import warmup
from core.artifacts import ArtifactType
from core.payloads import Chunk, Hit, Query, RetrievalResult
from core.ports import RunContext, Stage
from core.registry import registry
from plugins.rerank.cross_encoder import CrossEncoderConfig, CrossEncoderRerank

ROOT = Path(__file__).resolve().parents[2]
QUESTION = "What is the capital of France?"
MINILM = "cross-encoder/ms-marco-MiniLM-L-6-v2"


class FakeModel:
    """Scores each pair by a fixed table keyed on the passage text."""

    def __init__(self, scores: dict[str, float]):
        self.scores = scores
        self.calls: list[list[tuple[str, str]]] = []

    def predict(self, pairs):
        pairs = list(pairs)
        self.calls.append(pairs)
        return [self.scores[text] for _, text in pairs]


@pytest.fixture
def fake(monkeypatch):
    """Install a fake model; returns a setter for its score table."""
    loaded: list[str] = []
    holder: dict[str, FakeModel] = {}

    def install(scores: dict[str, float]) -> FakeModel:
        holder["model"] = FakeModel(scores)
        return holder["model"]

    def fake_load(model_id: str):
        loaded.append(model_id)
        return holder["model"]

    monkeypatch.setattr(ce, "_load", fake_load)
    install.loaded = loaded  # type: ignore[attr-defined]
    return install


def payload(texts: list[str]) -> dict:
    hits = [
        Hit(
            chunk=Chunk(
                id=f"chunk-{i}",
                text=text,
                doc_id="doc-1",
                ordinal=i,
                source_element_ids=[f"el-{i}"],
                page_span=(1, 1),
            ),
            score=1.0 - i / 10,
            rank=i + 1,
            retriever="dense",
        )
        for i, text in enumerate(texts)
    ]
    return RetrievalResult(
        hits=hits, query_id="q" * 16, fetch_k=len(hits), total_candidates=len(hits)
    ).model_dump(mode="json")


def ctx(tmp_path) -> RunContext:
    return RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)


def rerank(texts, tmp_path, run_ctx=None, **config) -> RetrievalResult:
    out = CrossEncoderRerank().apply(
        {"result": payload(texts), "query": Query(text=QUESTION).model_dump(mode="json")},
        CrossEncoderConfig(**config),
        run_ctx if run_ctx is not None else ctx(tmp_path),
    )
    return RetrievalResult.model_validate(out)


TEXTS = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"]
#: Reverses the input order: t6 scores highest.
REVERSED = {t: float(i) for i, t in enumerate(TEXTS)}


# -- registration and config ----------------------------------------------


def test_registered_under_the_rerank_stage():
    assert registry.get(Stage.RERANK, "cross_encoder") is CrossEncoderRerank
    assert CrossEncoderRerank.version == "1"


def test_ports_match_the_mmr_contract():
    ports = CrossEncoderRerank.inputs
    assert ports["result"].type == ArtifactType.RETRIEVAL_RESULT
    assert ports["query"].type == ArtifactType.QUERY and ports["query"].ambient
    assert "index" not in ports
    assert CrossEncoderRerank.output == ArtifactType.RETRIEVAL_RESULT


def test_config_defaults():
    config = CrossEncoderConfig()
    assert config.model == MINILM
    assert config.top_k == 5


def test_model_choices_are_the_three_in_the_spec():
    schema = CrossEncoderConfig.model_json_schema()["properties"]["model"]
    assert schema["enum"] == [
        MINILM,
        "BAAI/bge-reranker-base",
        "BAAI/bge-reranker-v2-m3",
    ]


def test_help_text_names_the_library_and_the_models():
    schema = CrossEncoderConfig.model_json_schema()["properties"]["model"]
    assert schema["description"] == (
        "A sentence-transformers CrossEncoder. MiniLM is small and fast; "
        "bge-reranker-base is stronger; bge-reranker-v2-m3 is strongest and "
        "slow on a CPU."
    )


def test_fingerprint_names_the_model():
    assert CrossEncoderRerank().fingerprint(CrossEncoderConfig()) == MINILM


# -- scoring ---------------------------------------------------------------


def test_scores_question_and_chunk_text_pairs(fake, tmp_path):
    model = fake(REVERSED)
    rerank(TEXTS, tmp_path)
    assert model.calls == [[(QUESTION, t) for t in TEXTS]]
    assert fake.loaded == [MINILM]


def test_loads_the_chosen_model(fake, tmp_path):
    fake(REVERSED)
    rerank(TEXTS, tmp_path, model="BAAI/bge-reranker-base")
    assert fake.loaded == ["BAAI/bge-reranker-base"]


def test_sorts_by_score_and_keeps_top_k(fake, tmp_path):
    fake(REVERSED)
    out = rerank(TEXTS, tmp_path, top_k=3)
    assert [h.chunk.text for h in out.hits] == ["t6", "t5", "t4"]
    assert [h.rank for h in out.hits] == [1, 2, 3]
    assert [h.score for h in out.hits] == [6.0, 5.0, 4.0]


def test_every_hit_carries_its_prior_rank_and_score(fake, tmp_path):
    fake(REVERSED)
    out = rerank(TEXTS, tmp_path, top_k=3)
    assert [h.prior_rank for h in out.hits] == [7, 6, 5]
    assert [h.prior_score for h in out.hits] == pytest.approx([0.4, 0.5, 0.6])


def test_the_retriever_name_is_left_as_is(fake, tmp_path):
    fake(REVERSED)
    out = rerank(TEXTS, tmp_path)
    assert {h.retriever for h in out.hits} == {"dense"}


def test_ties_keep_the_prior_order(fake, tmp_path):
    fake({t: 1.0 for t in TEXTS})
    out = rerank(TEXTS, tmp_path, top_k=7)
    assert [h.chunk.text for h in out.hits] == TEXTS


def test_a_pool_smaller_than_top_k_returns_every_candidate_reordered(fake, tmp_path):
    fake(REVERSED)
    out = rerank(TEXTS[:3], tmp_path, top_k=5)
    assert [h.chunk.text for h in out.hits] == ["t2", "t1", "t0"]
    assert [h.rank for h in out.hits] == [1, 2, 3]


def test_the_envelope_survives_and_counts_the_pool(fake, tmp_path):
    fake(REVERSED)
    out = rerank(TEXTS, tmp_path, top_k=3)
    assert out.query_id == "q" * 16
    assert out.total_candidates == 7


def test_empty_input_returns_empty_without_loading(fake, tmp_path):
    fake({})
    out = rerank([], tmp_path)
    assert out.hits == []
    assert fake.loaded == []


# -- the run note ------------------------------------------------------------


def note_for(texts, scores, fake, tmp_path, monkeypatch, **config) -> str:
    fake(scores)
    clock = iter([10.0, 10.3])
    monkeypatch.setattr(ce.time, "perf_counter", lambda: next(clock))
    run_ctx = ctx(tmp_path)
    rerank(texts, tmp_path, run_ctx=run_ctx, **config)
    return run_ctx.extras["meta"]["note"]


def test_note_reports_the_count_model_time_and_movement(fake, tmp_path, monkeypatch):
    note = note_for(TEXTS, REVERSED, fake, tmp_path, monkeypatch)
    # Top 5 is t6 t5 t4 t3 t2 against input t0 t1 t2 t3 t4: only rank 3 holds.
    assert note == (
        "Scored 7 candidates with MiniLM in 0.3 s. 4 of the top 5 changed place."
    )


def test_note_counts_zero_when_the_order_holds(fake, tmp_path, monkeypatch):
    scores = {t: -float(i) for i, t in enumerate(TEXTS)}
    note = note_for(TEXTS, scores, fake, tmp_path, monkeypatch, top_k=3)
    assert note.endswith("0 of the top 3 changed place.")


def test_note_counts_a_single_swap(fake, tmp_path, monkeypatch):
    scores = {"t0": 5.0, "t1": 6.0, "t2": 4.0, "t3": 3.0}
    note = note_for(TEXTS[:4], scores, fake, tmp_path, monkeypatch, top_k=3)
    assert note.endswith("2 of the top 3 changed place.")


def test_note_names_the_short_model(fake, tmp_path, monkeypatch):
    note = note_for(
        TEXTS, REVERSED, fake, tmp_path, monkeypatch, model="BAAI/bge-reranker-v2-m3"
    )
    assert "with bge-reranker-v2-m3 in" in note


def test_note_on_a_small_pool_counts_the_pieces_kept(fake, tmp_path, monkeypatch):
    note = note_for(TEXTS[:3], REVERSED, fake, tmp_path, monkeypatch, top_k=5)
    assert note == (
        "Scored 3 candidates with MiniLM in 0.3 s. 2 of the top 3 changed place."
    )


# -- explain -------------------------------------------------------------------


def test_explain_names_the_model_and_its_size():
    text = CrossEncoderRerank().explain(CrossEncoderConfig()).settings
    assert "MiniLM" in text and "22 million" in text and "5" in text


def test_explain_tradeoff_says_stronger_models_cost_seconds():
    tradeoff = CrossEncoderRerank().explain(CrossEncoderConfig()).tradeoff
    assert "seconds per question on a CPU" in tradeoff


def test_explain_blocks_a_top_k_below_one():
    explanation = CrossEncoderRerank().explain(CrossEncoderConfig(top_k=0))
    assert explanation.blocking and explanation.warning


# -- lazy loading ------------------------------------------------------------------


def test_load_caches_one_model_per_id(monkeypatch):
    built: list[str] = []

    class FakeCrossEncoder:
        def __init__(self, model_id, **kwargs):
            built.append(model_id)

    module = type(sys)("sentence_transformers")
    module.CrossEncoder = FakeCrossEncoder
    monkeypatch.setitem(sys.modules, "sentence_transformers", module)
    monkeypatch.setattr(ce, "_MODELS", {})
    first = ce._load("m-1")
    assert ce._load("m-1") is first
    ce._load("m-2")
    assert built == ["m-1", "m-2"]


def test_importing_the_plugin_does_not_import_torch():
    """A subprocess, so nothing an earlier test imported can mask the leak."""
    code = (
        "import sys\n"
        "import plugins.rerank.cross_encoder\n"
        "bad = [m for m in ('torch', 'sentence_transformers', 'transformers') "
        "if m in sys.modules]\n"
        "print(','.join(bad))\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, check=True
    )
    assert proc.stdout.strip() == ""


# -- warm-up ---------------------------------------------------------------------


def test_warm_up_loads_the_default_cross_encoder(monkeypatch):
    loaded: list[str] = []
    monkeypatch.setattr(ce, "_load", loaded.append)
    warmup._warm_reranker()
    assert loaded == [MINILM]


def test_a_failed_cross_encoder_download_is_logged_not_raised(monkeypatch, caplog):
    def boom(model_id):
        raise OSError("no network")

    monkeypatch.setattr(ce, "_load", boom)
    with caplog.at_level(logging.ERROR):
        warmup._warm_reranker()
    assert "no network" in caplog.text


def test_the_warm_up_loads_the_reranker_after_the_others(monkeypatch):
    import plugins.parse.docling as docling_plugin
    import providers.embeddings as embeddings

    calls: list[str] = []
    monkeypatch.setattr(
        docling_plugin,
        "_converter",
        lambda config: SimpleNamespace(initialize_pipeline=lambda fmt: calls.append("docling")),
    )
    monkeypatch.setattr(embeddings, "_load_model", lambda *args: calls.append("qwen"))
    monkeypatch.setattr(warmup, "_warm_reranker", lambda: calls.append("reranker"))
    warmup._warm()
    assert calls == ["docling", "qwen", "reranker"]
