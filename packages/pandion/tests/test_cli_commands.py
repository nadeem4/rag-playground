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


def test_retrieve_without_documents_says_how_to_name_them(folder):
    pandion("index", "pipeline.yaml", "report.pdf", cwd=folder)
    out = pandion("retrieve", "pipeline.yaml", "What is the capital of France?", cwd=folder)
    assert out.returncode == 2 and "--documents" in out.stderr and "--sync" in out.stderr


def test_retrieve_after_a_sync_searches_what_it_indexed(folder):
    pandion("index", "pipeline.yaml", "report.pdf", "--sync", cwd=folder)
    out = pandion("retrieve", "pipeline.yaml", "What is the capital of France?", cwd=folder)
    assert out.returncode == 0 and out.stdout.startswith("1. ")


def test_sync_says_what_changed(folder):
    first = pandion("index", "pipeline.yaml", "report.pdf", "--sync", cwd=folder)
    assert first.returncode == 0 and "added: report.pdf" in first.stdout
    again = pandion("index", "pipeline.yaml", "report.pdf", "--sync", cwd=folder)
    assert "unchanged: report.pdf" in again.stdout


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


def test_compare_varies_one_setting_and_names_the_best(with_questions):
    out = pandion("compare", "pipeline.yaml", "--vary", "chunk.chunk_size=70,200", "report.pdf", "--questions", "questions.json", cwd=with_questions)
    assert out.returncode == 0, out.stderr
    assert "chunk recursive_character chunk_size=70" in out.stdout
    assert "chunk recursive_character chunk_size=200" in out.stdout
    assert "Best:" in out.stdout or "No variant found an answer." in out.stdout


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
