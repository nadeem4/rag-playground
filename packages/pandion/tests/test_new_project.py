"""`pandion.new_project`: a ready-to-run project folder for a pipeline.

The golden files in golden/new_project/ hold, for each index x query template
pair, the written requirements.txt, the head of README.md and pipeline.yaml.
After a deliberate change, regenerate them with:

    PANDION_UPDATE_GOLDENS=1 uv run pytest packages/pandion/tests/test_new_project.py

The Pandion version pin is written as <pin> in the goldens, so a version bump
does not change them.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import pandion
from pdfs import SAMPLE_PAGES, build_pdf

GOLDEN = Path(__file__).parent / "golden" / "new_project"
UPDATE = bool(os.environ.get("PANDION_UPDATE_GOLDENS"))

INDEX = [t["id"] for t in pandion.list_templates()["index"]]
QUERY = [t["id"] for t in pandion.list_templates()["query"]]

#: A pipeline that needs no model download, no network and no key.
OFFLINE = {
    "path": "./pandion-index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "dense", "top_k": 3}},
    "answer": {"use": "search"},
}

QUESTIONS = [{"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}]


def pin() -> str:
    major, minor, *_ = pandion.__version__.split(".")
    return f"~={major}.{minor}.0"


def readme_head(text: str) -> str:
    """The README up to its first second-level heading."""
    return text.split("\n## ", 1)[0]


def golden_text(folder: Path) -> str:
    requirements = (folder / "requirements.txt").read_text(encoding="utf-8").replace(pin(), "~=<pin>")
    return (
        "=== requirements.txt\n" + requirements
        + "=== README.md (head)\n" + readme_head((folder / "README.md").read_text(encoding="utf-8")) + "\n"
        + "=== pipeline.yaml\n" + (folder / "pipeline.yaml").read_text(encoding="utf-8")
    )


@pytest.mark.parametrize("index", INDEX)
@pytest.mark.parametrize("query", QUERY)
def test_each_template_pair_matches_its_golden_files(tmp_path, index, query):
    folder = tmp_path / "project"
    pandion.new_project(folder, pandion.compose_template(index, query))
    golden = GOLDEN / f"{index}-{query}.txt"
    actual = golden_text(folder)
    if UPDATE:
        golden.parent.mkdir(parents=True, exist_ok=True)
        golden.write_text(actual, encoding="utf-8", newline="\n")
    assert actual == golden.read_text(encoding="utf-8")


def test_it_writes_the_project_files_and_returns_their_paths(tmp_path):
    folder = tmp_path / "project"
    written = pandion.new_project(folder, OFFLINE, QUESTIONS)

    names = sorted(p.relative_to(folder).as_posix() for p in written)
    assert names == ["README.md", "docs/.gitkeep", "pipeline.yaml", "questions.json", "requirements.txt", "run.py"]
    assert all(p.is_file() for p in written)
    assert (folder / "docs").is_dir()
    for p in written:
        assert b"\r\n" not in p.read_bytes(), p.name


def test_there_is_no_questions_file_without_questions(tmp_path):
    written = pandion.new_project(tmp_path / "project", OFFLINE)
    assert "questions.json" not in {p.name for p in written}


def test_it_takes_a_pipeline_object_too(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, pandion.Pipeline.from_dict(OFFLINE))
    assert yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))["path"] == "./pandion-index"


def test_requirements_pin_the_extras_the_pipeline_needs_and_this_minor_version(tmp_path):
    config = pandion.compose_template("tables", "chat")
    folder = tmp_path / "project"
    pandion.new_project(folder, config)

    extras = pandion.Pipeline.from_dict(config).extras()
    lines = (folder / "requirements.txt").read_text(encoding="utf-8").splitlines()
    assert f"pandion[{','.join(extras)}]{pin()}" in lines
    assert "# --extra-index-url https://download.pytorch.org/whl/cpu" in lines


def test_a_windows_style_relative_path_is_written_with_forward_slashes(tmp_path):
    config = {**OFFLINE, "path": ".\\indexes\\my-index", "models": {"cache_dir": "models\\cache"}}
    folder = tmp_path / "project"
    pandion.new_project(folder, config)

    written = yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))
    assert written["path"] == "./indexes/my-index"
    assert written["models"]["cache_dir"] == "./models/cache"


def test_no_absolute_path_is_written_anywhere(tmp_path):
    data = tmp_path / "server data" / "index"
    config = {**OFFLINE, "path": str(data), "models": {"cache_dir": str(tmp_path / "cache")}}
    folder = tmp_path / "project"
    written = pandion.new_project(folder, config, QUESTIONS)

    written_yaml = yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))
    assert written_yaml["path"] == "./index"
    assert written_yaml["models"]["cache_dir"] == "./cache"
    for p in written:
        text = p.read_text(encoding="utf-8")
        for form in (str(tmp_path), tmp_path.as_posix()):
            assert form not in text, p.name
        assert not re.search(r"\b[A-Za-z]:[\\/]", text), p.name


def test_a_folder_with_files_in_it_is_refused_unless_overwrite(tmp_path):
    folder = tmp_path / "project"
    folder.mkdir()
    (folder / "notes.txt").write_text("mine", encoding="utf-8")

    with pytest.raises(FileExistsError, match="overwrite=True"):
        pandion.new_project(folder, OFFLINE)
    assert not (folder / "pipeline.yaml").exists()

    pandion.new_project(folder, OFFLINE, overwrite=True)
    assert (folder / "pipeline.yaml").is_file()
    assert (folder / "notes.txt").read_text(encoding="utf-8") == "mine"


def test_an_empty_folder_is_fine(tmp_path):
    pandion.new_project(tmp_path, OFFLINE)
    assert (tmp_path / "run.py").is_file()


def test_the_written_pipeline_passes_pandion_validate(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, pandion.compose_template("manuals", "precision"))
    out = subprocess.run(
        [sys.executable, "-m", "pandion.cli", "validate", "pipeline.yaml"],
        cwd=folder, capture_output=True, text=True, encoding="utf-8", timeout=600,
    )
    assert out.returncode == 0, out.stderr


def test_the_readme_names_the_key_variable_but_never_a_key(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-value-123")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-secret-value-456")
    folder = tmp_path / "project"
    written = pandion.new_project(folder, pandion.compose_template("text", "chat"), QUESTIONS)

    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "ANTHROPIC_API_KEY" in readme
    for p in written:
        text = p.read_text(encoding="utf-8")
        assert "secret-value" not in text, p.name


def test_a_pipeline_with_no_model_says_it_needs_no_key(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE)
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "needs no API key" in readme
    assert "_API_KEY" not in readme


def test_the_readme_says_how_to_set_up_and_run(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, readme_extra="Scores to beat: 3 of 4 found.")
    readme = (folder / "README.md").read_text(encoding="utf-8")
    for words in ("Python 3.13", "python -m venv .venv", "pip install -r requirements.txt", "docs/", "python run.py"):
        assert words in readme
    assert readme.rstrip().endswith("Scores to beat: 3 of 4 found.")
    assert "\N{EM DASH}" not in readme


def test_the_readme_warns_when_questions_name_documents(tmp_path):
    named = [{**QUESTIONS[0], "document": "chunking-primer"}]
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, named)
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "chunking-primer" in readme and "must match" in readme

    plain = tmp_path / "plain"
    pandion.new_project(plain, OFFLINE, QUESTIONS)
    assert "must match" not in (plain / "README.md").read_text(encoding="utf-8")


def test_questions_can_come_from_a_file(tmp_path):
    source = tmp_path / "set.json"
    source.write_text(json.dumps(QUESTIONS), encoding="utf-8")
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, source)
    data = json.loads((folder / "questions.json").read_text(encoding="utf-8"))
    assert [q["question"] for q in data["questions"]] == ["What is the capital of France?"]


def _run(folder: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "run.py"], cwd=folder, capture_output=True, text=True, encoding="utf-8", timeout=600,
    )


def test_run_py_indexes_the_docs_and_runs_the_questions(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, QUESTIONS)
    (folder / "docs" / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))

    out = _run(folder)
    assert out.returncode == 0, out.stderr
    assert "report.pdf" in out.stdout
    assert "Found 1 of 1" in out.stdout
    assert "Cost: " in out.stdout


def test_run_py_asks_an_example_question_without_a_question_set(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE)
    (folder / "docs" / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))

    out = _run(folder)
    assert out.returncode == 0, out.stderr
    assert "Question: " in out.stdout and "Cost: " in out.stdout


def test_run_py_says_to_add_documents_when_docs_is_empty(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE)
    out = _run(folder)
    assert out.returncode == 1
    assert "docs" in out.stdout


# --- review fixes ------------------------------------------------------------


def test_settings_that_only_look_like_paths_are_copied_unchanged(tmp_path):
    config = {
        **OFFLINE,
        "index": {**OFFLINE["index"], "clean": [{"use": "drop_matching", "pattern": r"/\d+$", "mode": "regex"}]},
        "answer": {
            "use": "chat", "model": "custom", "custom_base_url": "https://llm.example.com/v1",
            "custom_model": "/models/Qwen3-8B", "prompt": "/no_think Answer from the pieces only.",
        },
    }
    folder = tmp_path / "project"
    pandion.new_project(folder, config)

    written = yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))
    assert written["index"]["clean"][0]["pattern"] == r"/\d+$"
    assert written["answer"]["custom_model"] == "/models/Qwen3-8B"
    assert written["answer"]["prompt"] == "/no_think Answer from the pieces only."


@pytest.mark.parametrize(
    "given, kept",
    [
        ("../../Users/nadee/secret-index", "./secret-index"),
        ("..\\..\\Users\\nadee\\models", "./models"),
        ("~/models", "./models"),
        ("C:data\\idx", "./idx"),
        ("file:///C:/srv/idx", "./idx"),
        ("indexes/../idx", "./idx"),
    ],
)
def test_a_path_that_leaves_the_folder_keeps_only_its_last_part(tmp_path, given, kept):
    config = {**OFFLINE, "path": given, "models": {"cache_dir": given}}
    folder = tmp_path / "project"
    written = pandion.new_project(folder, config)

    data = yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))
    assert data["path"] == kept
    assert data["models"]["cache_dir"] == kept
    for p in written:
        text = p.read_text(encoding="utf-8")
        assert "nadee" not in text and "srv" not in text, p.name


def test_overwrite_without_questions_removes_the_old_question_set_only(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, QUESTIONS)
    (folder / "notes.txt").write_text("mine", encoding="utf-8")

    pandion.new_project(folder, OFFLINE, overwrite=True)
    assert not (folder / "questions.json").exists()
    assert (folder / "notes.txt").is_file()


def test_the_readme_names_the_file_types_and_says_subfolders_are_not_read(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE)
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert ".pdf" in readme and "subfolders" in readme


def test_a_docling_project_reads_every_format_docling_declares(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, {**OFFLINE, "index": {**OFFLINE["index"], "parse": {"use": "docling"}}})
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "The pipeline reads .pdf, .docx, .pptx, .html, .htm, .md, .txt, .png, .jpg and .jpeg files" in readme
    assert "'.docx'" in (folder / "run.py").read_text(encoding="utf-8")


def test_run_py_skips_files_the_parser_cannot_read_and_says_so(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, QUESTIONS)
    (folder / "docs" / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (folder / "docs" / "notes.txt").write_text("not a pdf", encoding="utf-8")

    out = _run(folder)
    assert out.returncode == 0, out.stderr
    assert "Skipped notes.txt" in out.stdout
    assert "Found 1 of 1" in out.stdout


def test_run_py_says_plainly_when_docs_is_missing(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE)
    (folder / "docs" / ".gitkeep").unlink()
    (folder / "docs").rmdir()

    out = _run(folder)
    assert out.returncode == 1
    assert "Traceback" not in out.stderr
    assert "docs" in out.stdout


def test_the_readme_says_document_names_must_match_exactly(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, [{**QUESTIONS[0], "document": "report.pdf"}])
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "exactly" in readme and "extension" in readme


def test_run_py_stops_when_a_question_names_a_document_not_in_docs(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, OFFLINE, [{**QUESTIONS[0], "document": "primer.pdf"}])
    (folder / "docs" / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))

    out = _run(folder)
    assert out.returncode == 1, out.stderr
    assert "names the document primer.pdf, which is not one of the documents searched" in out.stdout
    assert "Traceback" not in out.stderr


def test_a_custom_endpoint_with_a_user_and_token_is_refused(tmp_path):
    config = {**OFFLINE, "answer": {"use": "chat", "model": "custom", "custom_model": "m",
                                    "custom_base_url": "https://user:token@llm.example.com/v1"}}
    with pytest.raises(ValueError, match="user name or password"):
        pandion.new_project(tmp_path / "project", config)
    assert not (tmp_path / "project").exists()


def test_public_endpoints_only_is_not_carried_into_the_project(tmp_path):
    folder = tmp_path / "project"
    pandion.new_project(folder, {**OFFLINE, "models": {"public_endpoints_only": True}})
    assert "public_endpoints_only" not in (folder / "pipeline.yaml").read_text(encoding="utf-8")


def test_a_custom_model_key_is_only_needed_if_the_server_asks(tmp_path):
    config = {**OFFLINE, "answer": {"use": "chat", "model": "custom", "custom_model": "m",
                                    "custom_base_url": "https://llm.example.com/v1"}}
    folder = tmp_path / "project"
    pandion.new_project(folder, config)
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "OPENAI_COMPATIBLE_API_KEY" in readme and "only if your server asks for a key" in readme


def test_a_pipeline_with_plugins_is_refused(tmp_path):
    with pytest.raises(ValueError, match="plugin modules cannot be packed"):
        pandion.new_project(tmp_path / "project", {**OFFLINE, "plugins": ["my_steps"]})
    assert not (tmp_path / "project").exists()


def test_a_folder_that_is_a_file_is_refused_plainly(tmp_path):
    target = tmp_path / "project"
    target.write_text("x", encoding="utf-8")
    with pytest.raises(NotADirectoryError, match="is a file, not a folder"):
        pandion.new_project(target, OFFLINE)
