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
