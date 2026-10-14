"""Contract tests for the cross-encoder reranker.

No test downloads a model: a fake is injected through the module's loader, so
the scores are whatever the test says they are and the ordering is exact.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

import pandion.plugins.rerank.cross_encoder as ce
from pandion.artifacts import ArtifactType
from pandion.payloads import Chunk, Hit, Query, RetrievalResult
from pandion.ports import RunContext, Stage
from pandion.models import ModelSettings, preload_reranker
from pandion.registry import registry
from pandion.plugins.rerank.cross_encoder import CrossEncoderConfig, CrossEncoderRerank

ROOT = Path(__file__).resolve().parents[1]
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

    def fake_load(model_id: str, settings=None):
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
    assert CrossEncoderRerank.version == "2"


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


def test_a_rewritten_question_is_judged_as_asked(fake, tmp_path):
    """Only retrieval sees an LLM rewrite; the reranker scores the question as typed."""
    model = fake(REVERSED)
    query = Query(text="capital France city", original=QUESTION)
    CrossEncoderRerank().apply(
        {"result": payload(TEXTS[:2]), "query": query.model_dump(mode="json")},
        CrossEncoderConfig(),
        ctx(tmp_path),
    )
    assert model.calls == [[(QUESTION, t) for t in TEXTS[:2]]]


def test_version_is_bumped_for_the_question_as_asked():
    assert CrossEncoderRerank.version == "2"
    settings = CrossEncoderRerank().explain(CrossEncoderConfig()).settings
    assert "the question as you typed it" in settings


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


@pytest.fixture
def built(monkeypatch):
    """A fake sentence_transformers whose CrossEncoder records how it was built."""
    calls: list[dict] = []

    class FakeCrossEncoder:
        def __init__(self, model_id, **kwargs):
            calls.append({"model_id": model_id, **kwargs})

    module = type(sys)("sentence_transformers")
    module.CrossEncoder = FakeCrossEncoder
    monkeypatch.setitem(sys.modules, "sentence_transformers", module)
    monkeypatch.setattr(ce, "_MODELS", {})
    return calls


CPU = ModelSettings(device="cpu")


def test_load_caches_one_model_per_id(built):
    first = ce._load("m-1", CPU)
    assert ce._load("m-1", CPU) is first
    ce._load("m-2", CPU)
    assert [call["model_id"] for call in built] == ["m-1", "m-2"]


def test_the_model_loads_on_the_device_and_folder_the_settings_name(built, tmp_path):
    ce._load("m-1", ModelSettings(device="cpu", cache_dir=tmp_path))
    assert built == [
        {
            "model_id": "m-1",
            "revision": "main",
            "device": "cpu",
            "cache_folder": str(tmp_path),
            "local_files_only": False,
        }
    ]


def test_one_model_on_two_devices_is_two_models(built):
    ce._load("m-1", CPU)
    ce._load("m-1", ModelSettings(device="cuda"))
    assert [call["device"] for call in built] == ["cpu", "cuda"]


def test_download_never_loads_only_a_model_already_in_the_folder(built, monkeypatch):
    checked: list[tuple] = []
    monkeypatch.setattr(ce, "check_downloaded", lambda *args: checked.append(args))
    settings = ModelSettings(device="cpu", download="never")
    ce._load("m-1", settings)
    assert checked == [("m-1", "main", settings)]
    assert built[0]["local_files_only"] is True


def test_the_run_hands_its_model_settings_to_the_load(tmp_path, monkeypatch):
    seen: list = []

    def fake_load(model_id, settings=None):
        seen.append(settings)
        return FakeModel(REVERSED)

    monkeypatch.setattr(ce, "_load", fake_load)
    run_ctx = ctx(tmp_path)
    run_ctx.extras["models"] = CPU
    rerank(TEXTS, tmp_path, run_ctx=run_ctx)
    assert seen == [CPU]


def test_preload_reranker_loads_the_default_cross_encoder(monkeypatch):
    seen: list = []
    monkeypatch.setattr(ce, "_load", lambda model_id, settings=None: seen.append((model_id, settings)))
    preload_reranker(settings=CPU)
    assert seen == [(MINILM, CPU)]


def test_importing_the_plugin_does_not_import_torch():
    """A subprocess, so nothing an earlier test imported can mask the leak."""
    code = (
        "import sys\n"
        "import pandion.plugins.rerank.cross_encoder\n"
        "bad = [m for m in ('torch', 'sentence_transformers', 'transformers') "
        "if m in sys.modules]\n"
        "print(','.join(bad))\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, check=True
    )
    assert proc.stdout.strip() == ""


def test_note_times_the_scoring_not_the_model_load(tmp_path, monkeypatch):
    now = [100.0]
    model = FakeModel(REVERSED)

    def slow_load(model_id: str, settings=None) -> FakeModel:
        now[0] += 5.0  # a download and load the note must not count
        return model

    def scoring(pairs):
        now[0] += 0.3
        return FakeModel.predict(model, pairs)

    model.predict = scoring  # type: ignore[method-assign]
    monkeypatch.setattr(ce, "_load", slow_load)
    monkeypatch.setattr(ce.time, "perf_counter", lambda: now[0])
    run_ctx = ctx(tmp_path)
    rerank(TEXTS, tmp_path, run_ctx=run_ctx)
    assert " in 0.3 s." in run_ctx.extras["meta"]["note"]


def test_a_sub_tenth_note_says_under_a_tenth_of_a_second(tmp_path, monkeypatch):
    model = FakeModel(REVERSED)
    clock = iter([10.0, 10.01])
    monkeypatch.setattr(ce, "_load", lambda model_id, settings=None: model)
    monkeypatch.setattr(ce.time, "perf_counter", lambda: next(clock))
    run_ctx = ctx(tmp_path)
    rerank(TEXTS[:6], tmp_path, run_ctx=run_ctx)
    assert run_ctx.extras["meta"]["note"].startswith(
        "Scored 6 candidates with MiniLM in under 0.1 s."
    )


def test_explain_says_scores_differ_between_models():
    explanation = CrossEncoderRerank().explain(CrossEncoderConfig())
    assert (
        "Scores are on the model's own scale and differ between models, so "
        "compare the order, not the numbers."
    ) in explanation.settings + " " + explanation.tradeoff


import typing


def test_every_model_is_pinned_to_a_commit():
    assert set(ce.PINNED) == set(typing.get_args(ce.CrossEncoderModel))
    assert all(len(sha) == 40 and int(sha, 16) >= 0 for sha in ce.PINNED.values())


def test_the_default_revision_keeps_the_id_and_a_set_one_moves_it():
    default = CrossEncoderConfig()
    assert default.revision == ""
    assert default.model_dump(mode="json") == {"model": MINILM, "top_k": 5}
    assert CrossEncoderRerank().fingerprint(default) == MINILM
    pinned = CrossEncoderConfig(revision="abc123")
    assert pinned.model_dump(mode="json")["revision"] == "abc123"
    assert CrossEncoderRerank().fingerprint(pinned) == f"{MINILM}@abc123"


def test_a_model_loads_at_its_pinned_revision(built):
    ce._load(MINILM, CPU)
    assert built[0]["revision"] == ce.PINNED[MINILM]


def test_a_revision_that_was_set_is_the_one_loaded(built):
    ce._model_for(CrossEncoderConfig(revision="abc123"), CPU)
    assert built[0]["revision"] == "abc123"


def test_explain_names_a_set_revision():
    pinned = CrossEncoderRerank().explain(CrossEncoderConfig()).settings
    assert "at commit" not in pinned
    text = CrossEncoderRerank().explain(CrossEncoderConfig(revision="abc123")).settings
    assert "MiniLM at commit abc123," in text
