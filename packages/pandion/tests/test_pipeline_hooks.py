"""What an app needs to drive an index run: one card, progress, stop, keys, a re-run.

One small PDF, pdfium and the fake embedder: nothing reaches the network.
"""

import json
import threading
from pathlib import Path

import pytest

import pandion.pipeline as pipeline_module
from pandion import Pipeline
from pdfs import SAMPLE_PAGES, build_pdf

CONFIG = {
    "path": "./index",
    "models": {"device": "cpu"},
    "index": {
        "parse": {"use": "pdfium"},
        "clean": [{"use": "dedupe_blocks"}],
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}
TWO_CLEANERS = {
    **CONFIG,
    "index": {**CONFIG["index"], "clean": [{"use": "dedupe_blocks"}, {"use": "header_footer_strip"}]},
}
NO_CLEANER = {**CONFIG, "index": {k: v for k, v in CONFIG["index"].items() if k != "clean"}}


@pytest.fixture
def p(tmp_path: Path) -> Pipeline:
    return Pipeline.from_dict(CONFIG, base=tmp_path)


@pytest.fixture
def pdf(tmp_path: Path) -> Path:
    f = tmp_path / "report.pdf"
    f.write_bytes(build_pdf(SAMPLE_PAGES))
    return f


def steps(report, doc="report.pdf"):
    return list(report.documents[doc].stages)


def finished(events):
    return [e for e in events if e["event"] == "node_finished"]


def test_through_chunk_stops_before_the_index(p, pdf):
    report = p.index.run(pdf, through="chunk")
    assert steps(report) == ["source", "parse", "clean.1", "chunk"]
    assert report.index is None
    assert report.ok


def test_through_parse_stops_after_parse(p, pdf):
    assert steps(p.index.run(pdf, through="parse")) == ["source", "parse"]


def test_through_clean_stops_after_the_last_cleaner_and_clean_n_after_that_one(tmp_path, pdf):
    p = Pipeline.from_dict(TWO_CLEANERS, base=tmp_path)
    assert steps(p.index.run(pdf, through="clean")) == ["source", "parse", "clean.1", "clean.2"]
    assert steps(p.index.run(pdf, through="clean.1")) == ["source", "parse", "clean.1"]


def test_through_clean_without_cleaners_stops_after_parse(tmp_path, pdf):
    p = Pipeline.from_dict(NO_CLEANER, base=tmp_path)
    assert steps(p.index.run(pdf, through="clean")) == ["source", "parse"]


def test_through_index_is_the_whole_run(p, pdf):
    report = p.index.run(pdf, through="index")
    assert report.index is not None and report.index.status == "executed"


def test_an_unknown_through_is_refused_before_anything_runs(p, pdf):
    with pytest.raises(ValueError, match="through names the step to stop after"):
        p.index.run(pdf, through="embed")
    assert not (p.config.path / "artifacts").exists()


def test_on_event_names_each_step_and_its_document(p, pdf):
    events = []
    p.index.run(pdf, on_event=events.append)
    assert [(e["document"], e["step"]) for e in finished(events)] == [
        ("report.pdf", "source"),
        ("report.pdf", "parse"),
        ("report.pdf", "clean.1"),
        ("report.pdf", "chunk"),
        (None, "index"),
    ]
    assert events[0]["event"] == "run_started" and events[-1]["event"] == "run_finished"
    assert json.loads(json.dumps(events)) == events


def test_a_second_run_is_all_cache_hits_unless_forced(p, pdf):
    p.index.run(pdf)
    events = []
    p.index.run(pdf, on_event=events.append)
    assert all(e["cache_hit"] for e in finished(events))
    events.clear()
    p.index.run(pdf, on_event=events.append, force=True)
    assert not any(e["cache_hit"] for e in finished(events))


def test_force_with_through_runs_that_step_and_the_ones_above_again(p, pdf):
    p.index.run(pdf)
    events = []
    p.index.run(pdf, through="parse", force=True, on_event=events.append)
    assert [e["step"] for e in finished(events) if not e["cache_hit"]] == ["source", "parse"]


def test_a_cancel_set_before_the_run_skips_every_step(p, pdf):
    stop = threading.Event()
    stop.set()
    report = p.index.run(pdf, cancel=stop)
    assert not report.ok
    assert {s.status for s in report.documents["report.pdf"].stages.values()} == {"skipped"}
    assert report.index.status == "skipped"


def test_a_cancel_stops_the_run_between_steps(p, pdf):
    stop = threading.Event()

    def on_event(e):
        if e["event"] == "node_finished" and e.get("step") == "parse":
            stop.set()

    report = p.index.run(pdf, on_event=on_event, cancel=stop)
    stages = report.documents["report.pdf"].stages
    assert stages["parse"].status == "executed"
    assert [stages["clean.1"].status, stages["chunk"].status, report.index.status] == ["skipped"] * 3
    assert not report.ok


def test_credentials_reach_the_steps_and_are_never_written(p, pdf, monkeypatch):
    seen = {}
    real = pipeline_module.run

    def spy(*args, **kwargs):
        seen.update(kwargs["context_extras"])
        return real(*args, **kwargs)

    monkeypatch.setattr(pipeline_module, "run", spy)
    report = p.index.run(pdf, credentials={"openai_api_key": "sk-test-not-real"})
    assert report.ok
    assert seen["credentials"] == {"openai_api_key": "sk-test-not-real"}
    written = [f for f in p.config.path.rglob("*") if f.is_file() and b"sk-test-not-real" in f.read_bytes()]
    assert written == []


def test_an_on_event_callback_that_raises_stops_the_run(p, pdf):
    def boom(e):
        if e["event"] == "node_started" and e.get("step") == "chunk":
            raise RuntimeError("callback failed")

    with pytest.raises(RuntimeError, match="callback failed"):
        p.index.run(pdf, on_event=boom)
    events = []
    p.index.run(pdf, on_event=events.append)
    hits = {e["step"]: e["cache_hit"] for e in finished(events)}
    assert hits["parse"] is True and hits["chunk"] is False


def test_a_named_document_gives_the_same_results_as_the_file_of_that_name(tmp_path, pdf):
    kept = tmp_path / "uploads"
    kept.mkdir()
    renamed = kept / "0f3a9c.pdf"
    renamed.write_bytes(pdf.read_bytes())
    p = Pipeline.from_dict(CONFIG, base=tmp_path)
    by_file = p.index.run(pdf, through="chunk").documents["report.pdf"].stages
    report = p.index.run({"report.pdf": renamed}, through="chunk")
    assert list(report.documents) == ["report.pdf"]
    by_name = report.documents["report.pdf"].stages
    assert [s.artifact_id for s in by_name.values()] == [s.artifact_id for s in by_file.values()]
    assert by_name["source"].output["filename"] == "report.pdf"


def test_a_named_document_in_a_folder_keeps_its_folder(p, pdf):
    report = p.index.run({"guides/intro.pdf": pdf}, through="parse")
    assert list(report.documents) == ["guides/intro.pdf"]
    assert report.documents["guides/intro.pdf"].stages["source"].output["filename"] == "intro.pdf"


def test_an_empty_mapping_is_refused(p):
    with pytest.raises(ValueError, match="There are no documents to index"):
        p.index.run({})


def test_run_started_names_every_step_and_the_selected_ones(p, pdf):
    events = []
    p.index.run(pdf, through="parse", on_event=events.append)
    started = events[0]
    assert started["event"] == "run_started"
    assert started["steps"] == [
        {"document": "report.pdf", "step": "source"},
        {"document": "report.pdf", "step": "parse"},
        {"document": "report.pdf", "step": "clean.1"},
        {"document": "report.pdf", "step": "chunk"},
        {"document": None, "step": "index"},
    ]
    assert started["selected_steps"] == [
        {"document": "report.pdf", "step": "parse"},
        {"document": "report.pdf", "step": "source"},
    ]
    assert json.loads(json.dumps(events)) == events


def test_run_cancelled_names_the_skipped_steps(p, pdf):
    stop = threading.Event()
    events = []

    def on_event(e):
        events.append(e)
        if e["event"] == "node_finished" and e.get("step") == "parse":
            stop.set()

    p.index.run(pdf, on_event=on_event, cancel=stop)
    cancelled = next(e for e in events if e["event"] == "run_cancelled")
    assert cancelled["skipped_steps"] == [
        {"document": "report.pdf", "step": "clean.1"},
        {"document": "report.pdf", "step": "chunk"},
        {"document": None, "step": "index"},
    ]


@pytest.mark.parametrize("through", ["clean.01", "clean.2", "clean.0", "clean. 1", "Chunk"])
def test_through_must_be_an_exact_step_name(p, pdf, through):
    with pytest.raises(ValueError, match="one of parse, clean, clean.1, chunk, index"):
        p.index.run(pdf, through=through)
    assert not (p.config.path / "artifacts").exists()


def test_through_stops_each_of_several_documents_at_that_step(p, pdf, tmp_path):
    other = tmp_path / "other.pdf"
    other.write_bytes(pdf.read_bytes())
    report = p.index.run([pdf, other], through="clean.1")
    assert steps(report, "report.pdf") == ["source", "parse", "clean.1"]
    assert steps(report, "other.pdf") == ["source", "parse", "clean.1"]
    assert report.index is None and report.ok


def test_sync_takes_a_mapping_of_names(p, pdf, tmp_path):
    kept = tmp_path / "0f3a9c.pdf"
    kept.write_bytes(pdf.read_bytes())
    report = p.index.sync({"report.pdf": kept})
    assert report.ok and report.added == ["report.pdf"]
    assert p.index.sync({"report.pdf": kept}).unchanged == ["report.pdf"]


SEARCH = {**CONFIG, "retrieve": {"search": {"use": "hybrid_rrf", "top_k": 3}}, "answer": {"use": "search"}}


@pytest.fixture
def capitals(tmp_path):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    a.write_bytes(build_pdf([["Paris is the capital of France."]]))
    b.write_bytes(build_pdf([["Berlin is the capital of Germany."]]))
    return a, b


def test_documents_limits_the_search_to_those_files(tmp_path, capitals):
    a, b = capitals
    p = Pipeline.from_dict(SEARCH, base=tmp_path)
    p.index.run([a, b])
    hits = p.retrieve("capital", documents=b).hits
    assert hits and all("Berlin" in h.chunk.text for h in hits)
    assert any("Paris" in h.chunk.text for h in p.retrieve("capital").hits)


def test_documents_do_not_change_what_the_index_holds(tmp_path, capitals):
    a, b = capitals
    p = Pipeline.from_dict(SEARCH, base=tmp_path)
    p.index.run([a, b])
    p.retrieve("capital", documents=b)
    assert set(p.index.indexed()) == {"a.pdf", "b.pdf"}


def test_documents_not_yet_indexed_are_indexed_first(tmp_path):
    f = tmp_path / "c.pdf"
    f.write_bytes(build_pdf([["Rome is the capital of Italy."]]))
    p = Pipeline.from_dict(SEARCH, base=tmp_path)
    assert any("Rome" in h.chunk.text for h in p.retrieve("capital", documents=f).hits)


def test_retrieve_reports_progress_by_step(tmp_path, pdf):
    p = Pipeline.from_dict(SEARCH, base=tmp_path)
    events = []
    p.retrieve("capital", documents=pdf, on_event=events.append)
    done = [(e["document"], e["step"]) for e in finished(events)]
    assert done[-1] == (None, "search")          # the search reads the index and the question, so it is last
    assert (None, "rewrite") in done and ("report.pdf", "chunk") in done


def test_ask_takes_documents_and_reports_the_answer_step(tmp_path, pdf):
    p = Pipeline.from_dict(SEARCH, base=tmp_path)
    events = []
    answer = p.ask("capital", documents=pdf, on_event=events.append)
    assert answer.ok
    assert finished(events)[-1]["step"] == "answer"


def test_a_cancelled_search_finds_nothing_and_says_so(tmp_path, pdf):
    stop = threading.Event()
    stop.set()
    result = Pipeline.from_dict(SEARCH, base=tmp_path).retrieve("capital", documents=pdf, cancel=stop)
    assert not result.ok and result.hits == []
    assert result.stages["search"].status == "skipped"
    assert result.stages["rewrite"].status == "skipped"


@pytest.mark.parametrize("on", [True, False])
def test_the_public_endpoint_switch_reaches_every_step(tmp_path, pdf, monkeypatch, on):
    seen = {}
    real = pipeline_module.run

    def spy(*args, **kwargs):
        seen.update(kwargs["context_extras"])
        return real(*args, **kwargs)

    monkeypatch.setattr(pipeline_module, "run", spy)
    config = {**CONFIG, "models": {"device": "cpu", "public_endpoints_only": on}}
    Pipeline.from_dict(config, base=tmp_path).index.run(pdf, through="parse")
    assert seen["public_endpoints_only"] is on


def test_the_switch_is_written_back_only_when_on(tmp_path):
    config = {**CONFIG, "models": {"device": "cpu", "public_endpoints_only": True}}
    assert Pipeline.from_dict(config, base=tmp_path).to_dict()["models"] == {
        "device": "cpu", "public_endpoints_only": True,
    }
    assert "public_endpoints_only" not in Pipeline.from_dict(CONFIG, base=tmp_path).to_dict()["models"]


def test_the_public_endpoint_switch_reaches_the_search_steps(tmp_path, pdf, monkeypatch):
    config = {**SEARCH, "models": {"device": "cpu", "public_endpoints_only": True}}
    p = Pipeline.from_dict(config, base=tmp_path)
    p.index.run(pdf)
    seen = []
    real = pipeline_module.run

    def spy(*args, **kwargs):
        seen.append(kwargs["context_extras"])
        return real(*args, **kwargs)

    monkeypatch.setattr(pipeline_module, "run", spy)
    assert p.retrieve("capital").ok
    assert seen and all(extras["public_endpoints_only"] is True for extras in seen)
