"""The pandion command, run as a person runs it: a subprocess."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from pandion.cli import parse_vary
from pdfs import SAMPLE_PAGES, build_pdf

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "examples" / "pandion" / "own_strategies"

#: A pipeline that needs no model download and no network.
PIPELINE = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "dense", "top_k": 3}},
    "answer": {"use": "search"},
}


def pandion(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "pandion.cli", *args],
        cwd=cwd, capture_output=True, text=True, timeout=600, encoding="utf-8",
    )


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    (tmp_path / "pipeline.yaml").write_text(yaml.safe_dump(PIPELINE, sort_keys=False), encoding="utf-8")
    (tmp_path / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return tmp_path


def test_validate_says_a_good_file_is_valid_and_a_bad_one_why(folder):
    ok = pandion("validate", "pipeline.yaml", cwd=folder)
    assert ok.returncode == 0 and "pipeline.yaml is a valid pipeline." in ok.stdout
    (folder / "bad.yaml").write_text("path: ./index\n", encoding="utf-8")
    bad = pandion("validate", "bad.yaml", cwd=folder)
    assert bad.returncode == 2 and bad.stderr.startswith("pandion: ") and "index" in bad.stderr


def test_strategies_lists_each_stage_with_its_summaries(folder):
    out = pandion("strategies", "--stage", "chunk", cwd=folder)
    assert out.returncode == 0
    assert "recursive_character" in out.stdout and "token_based" in out.stdout
    data = json.loads(pandion("strategies", "--json", cwd=folder).stdout)
    assert "recursive_character" in data["chunk"]


def test_index_then_retrieve_then_ask(folder):
    index = pandion("index", "pipeline.yaml", "report.pdf", cwd=folder)
    assert index.returncode == 0, index.stderr
    assert "report.pdf" in index.stdout and "chunk" in index.stdout and "index" in index.stdout
    hits = pandion("retrieve", "pipeline.yaml", "What is the capital of France?", "--k", "2", "--documents", "report.pdf", cwd=folder)
    assert hits.returncode == 0 and hits.stdout.startswith("1. ")
    answer = pandion("ask", "pipeline.yaml", "What is the capital of France?", "--documents", "report.pdf", cwd=folder)
    assert answer.returncode == 0 and "Paris" in answer.stdout


def test_index_through_a_step_stops_there(folder):
    out = pandion("index", "pipeline.yaml", "report.pdf", "--through", "chunk", cwd=folder)
    assert out.returncode == 0 and "chunk" in out.stdout
    assert "\nindex" not in out.stdout


def test_retrieve_after_a_plain_index_searches_what_it_indexed(folder):
    index = pandion("index", "pipeline.yaml", "report.pdf", cwd=folder)
    assert index.returncode == 0, index.stderr
    assert "added:" not in index.stdout
    out = pandion("retrieve", "pipeline.yaml", "What is the capital of France?", cwd=folder)
    assert out.returncode == 0 and out.stdout.startswith("1. ")


def test_retrieve_before_any_index_says_how_to_name_the_documents(folder):
    out = pandion("retrieve", "pipeline.yaml", "What is the capital of France?", cwd=folder)
    assert out.returncode == 2 and "--documents" in out.stderr and "pandion index" in out.stderr


def test_retrieve_after_a_sync_searches_what_it_indexed(folder):
    pandion("index", "pipeline.yaml", "report.pdf", "--sync", cwd=folder)
    out = pandion("retrieve", "pipeline.yaml", "What is the capital of France?", cwd=folder)
    assert out.returncode == 0 and out.stdout.startswith("1. ")


def test_sync_says_what_changed(folder):
    first = pandion("index", "pipeline.yaml", "report.pdf", "--sync", cwd=folder)
    assert first.returncode == 0 and "added: report.pdf" in first.stdout
    again = pandion("index", "pipeline.yaml", "report.pdf", "--sync", cwd=folder)
    assert "unchanged: report.pdf" in again.stdout


def test_sync_lists_a_file_it_left_out_and_exits_1(folder):
    (folder / "bad.pdf").write_bytes(b"%PDF-1.4 not really")
    out = pandion("index", "pipeline.yaml", "report.pdf", "bad.pdf", "--sync", cwd=folder)
    assert out.returncode == 1
    assert any(line.startswith("failed: bad.pdf: ") for line in out.stdout.splitlines())
    assert "added: report.pdf" in out.stdout


def test_plugins_name_modules_to_import_before_the_file_is_read(tmp_path):
    data = yaml.safe_load((EXAMPLE / "pipeline.yaml").read_text(encoding="utf-8"))
    data.pop("plugins")
    (tmp_path / "pipeline.yaml").write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    file = str(tmp_path / "pipeline.yaml")
    without = pandion("validate", file, cwd=EXAMPLE)
    assert without.returncode == 2
    with_plugins = pandion("validate", file, "--plugins", "my_strategies", cwd=EXAMPLE)
    assert with_plugins.returncode == 0, with_plugins.stderr
    missing = pandion("validate", file, "--plugins", "no_such_module", cwd=EXAMPLE)
    assert missing.returncode == 2 and "no_such_module" in missing.stderr


QUESTIONS = [{"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}]


@pytest.fixture
def with_questions(folder: Path) -> Path:
    (folder / "questions.json").write_text(json.dumps(QUESTIONS), encoding="utf-8")
    return folder


def test_eval_prints_each_question_and_the_totals(with_questions):
    out = pandion("eval", "pipeline.yaml", "questions.json", "--documents", "report.pdf", "--top-k", "3", cwd=with_questions)
    assert out.returncode == 0, out.stderr
    assert "capital found at rank" in out.stdout and "Found 1 of 1" in out.stdout
    data = json.loads(pandion("eval", "pipeline.yaml", "questions.json", "--documents", "report.pdf", "--json", cwd=with_questions).stdout)
    assert data["total"] == 1 and data["questions"][0]["id"] == "capital"
    # No step calls a model: the cost line has time and the cache share, no tokens or dollars.
    [line] = [l for l in out.stdout.splitlines() if l.startswith("Cost: ")]
    assert " s; " in line and "steps cached" in line and "tokens" not in line and "$" not in line
    assert data["cost"]["dollars"] is None and data["cost"]["steps_run"] + data["cost"]["steps_cached"] > 0


def test_compare_varies_one_setting_and_names_the_best(with_questions):
    out = pandion("compare", "pipeline.yaml", "--vary", "chunk.chunk_size=70,200", "report.pdf", "--questions", "questions.json", cwd=with_questions)
    assert out.returncode == 0, out.stderr
    assert "chunk recursive_character chunk_size=70" in out.stdout
    assert "chunk recursive_character chunk_size=200" in out.stdout
    assert "Best:" in out.stdout or "No variant found an answer." in out.stdout
    cost_lines = [l for l in out.stdout.splitlines() if l.startswith("  Cost: ")]
    assert len(cost_lines) == 2 and all("steps cached" in l for l in cost_lines)


def test_compare_without_questions_shows_each_variants_step(with_questions):
    out = pandion("compare", "pipeline.yaml", "--vary", "chunk.chunk_size=70,200", "report.pdf", "--json", cwd=with_questions)
    data = json.loads(out.stdout)
    assert [c["variant"]["chunk_size"] for c in data["comparisons"]] == [70, 200]


@pytest.mark.parametrize(
    ("spec", "stage", "variants"),
    [
        ("chunk.chunk_size=200,400", "chunk", [{"use": "recursive_character", "chunk_size": 200, "chunk_overlap": 10}, {"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 10}]),
        ("search.use=dense,bm25", "search", [{"use": "dense"}, {"use": "bm25"}]),
        ("search.top_k=3,null", "search", [{"use": "dense", "top_k": 3}, {"use": "dense", "top_k": None}]),
    ],
)
def test_parse_vary_reads_each_value_as_yaml(spec, stage, variants):
    assert parse_vary(spec, PIPELINE) == (stage, variants)


def test_parse_vary_reads_a_place_in_a_list():
    config = {**PIPELINE, "index": {**PIPELINE["index"], "clean": [{"use": "dedupe_blocks"}, {"use": "drop_short", "min_chars": 10}]}}
    stage, variants = parse_vary("clean.2.min_chars=20,40", config)
    assert stage == "clean"
    assert variants[1] == [{"use": "dedupe_blocks"}, {"use": "drop_short", "min_chars": 40}]


@pytest.mark.parametrize("spec", ["chunk", "chunk.chunk_size", "answer.use=chat", "clean.min_chars=1", "clean.3.min_chars=1"])
def test_a_wrong_vary_says_how_to_write_it(spec):
    config = {**PIPELINE, "index": {**PIPELINE["index"], "clean": [{"use": "dedupe_blocks"}]}}
    with pytest.raises(ValueError):
        parse_vary(spec, config)


@pytest.mark.parametrize("spec", ["chunk.chunk_size=[1", "chunk.chunk_size=200,,400"])
def test_a_bad_vary_value_is_named(spec):
    with pytest.raises(ValueError) as caught:
        parse_vary(spec, PIPELINE)
    assert "chunk.chunk_size=200,400,800" in str(caught.value)


def test_a_bad_vary_value_exits_2_without_a_traceback(folder):
    out = pandion("compare", "pipeline.yaml", "--vary", "chunk.chunk_size=[1", "report.pdf", cwd=folder)
    assert out.returncode == 2 and out.stderr.startswith("pandion: ") and "[1" in out.stderr
    assert "Traceback" not in out.stderr


@pytest.mark.parametrize("args", [["validate", "broken.yaml"], ["install", "broken.yaml", "--print"], ["index", "broken.yaml", "report.pdf"]])
def test_a_broken_yaml_file_names_the_file_and_line(folder, args):
    (folder / "broken.yaml").write_text("path: ./x\nindex: [\n", encoding="utf-8")
    out = pandion(*args, cwd=folder)
    assert out.returncode == 2 and "Traceback" not in out.stderr
    assert out.stderr.startswith("pandion: broken.yaml is not valid YAML") and "line " in out.stderr


def test_strategies_of_an_unknown_stage_lists_the_stages(folder):
    out = pandion("strategies", "--stage", "nope", cwd=folder)
    assert out.returncode == 2 and "nope" in out.stderr and "chunk" in out.stderr and "rerank" in out.stderr


def test_the_no_index_hint_offers_sync_only_when_the_pipeline_can_sync(tmp_path):
    data = yaml.safe_load((EXAMPLE / "pipeline.yaml").read_text(encoding="utf-8"))
    data["path"] = str(tmp_path / "index")
    (tmp_path / "pipeline.yaml").write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    out = pandion("retrieve", str(tmp_path / "pipeline.yaml"), "tides", cwd=EXAMPLE)
    assert out.returncode == 2 and "--documents" in out.stderr and "--sync" not in out.stderr
