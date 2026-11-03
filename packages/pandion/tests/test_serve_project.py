"""`new_project(kind="serve")`: the files of a serve project.

The golden files in golden/serve_project/ hold the rendered pipeline.yaml,
pyproject.toml, .env.example, the Dockerfile and the head of README.md. After a
deliberate change, regenerate them with:

    PANDION_UPDATE_GOLDENS=1 uv run pytest packages/pandion/tests/test_serve_project.py

The Pandion and pandion-api version pins are written as <pin> in the goldens.
"""

import json
import os
import re
from importlib.resources import files
from pathlib import Path

import pytest
import yaml

import pandion
from pandion.project import SERVE_API_PIN

GOLDEN = Path(__file__).parent / "golden" / "serve_project"
UPDATE = bool(os.environ.get("PANDION_UPDATE_GOLDENS"))

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

FIXED = ["serve.py", "policy.py", "Dockerfile", ".dockerignore", ".gitignore", "tests/test_quality.py"]
SETS = {
    "contracts": {"questions": [{"id": "c1", "question": "Who signs?", "gold_answers": ["The buyer."]}]},
    "policies": {"document": "hr.pdf", "questions": [{"id": "p1", "question": "How many days?", "gold_answers": ["Ten."]}]},
}


def pin() -> str:
    major, minor, *_ = pandion.__version__.split(".")
    return f"~={major}.{minor}.0"


def make(tmp_path: Path, pipeline=OFFLINE, **kwargs) -> Path:
    folder = tmp_path / "project"
    pandion.new_project(folder, pipeline, kind="serve", **kwargs)
    return folder


def template(name: str) -> str:
    return files("pandion.templates.serve").joinpath(name).read_text(encoding="utf-8")


def yaml_of(folder: Path) -> dict:
    return yaml.safe_load((folder / "pipeline.yaml").read_text(encoding="utf-8"))


def test_serve_project_writes_exactly_the_documented_files(tmp_path):
    folder = tmp_path / "project"
    written = pandion.new_project(folder, OFFLINE, kind="serve", categories_questions=SETS)
    names = sorted(p.relative_to(folder).as_posix() for p in written)
    assert names == sorted([*FIXED, "pyproject.toml", "pipeline.yaml", ".env.example", "evals/questions.json", "README.md"])
    assert all(p.is_file() for p in written)
    assert not (folder / "docs").exists()


def test_laptop_project_is_unchanged(tmp_path):
    written = pandion.new_project(tmp_path / "project", OFFLINE)
    assert sorted(p.relative_to(tmp_path / "project").as_posix() for p in written) == [
        "README.md", "docs/.gitkeep", "pipeline.yaml", "requirements.txt", "run.py",
    ]


def test_kind_must_be_laptop_or_serve(tmp_path):
    with pytest.raises(ValueError, match="kind must be 'laptop' or 'serve'"):
        pandion.new_project(tmp_path / "p", OFFLINE, kind="cloud")


def test_serve_refuses_a_folder_with_files_unless_overwrite(tmp_path):
    folder = tmp_path / "project"
    folder.mkdir()
    (folder / "mine.txt").write_text("keep")
    with pytest.raises(FileExistsError):
        pandion.new_project(folder, OFFLINE, kind="serve")
    pandion.new_project(folder, OFFLINE, kind="serve", overwrite=True)
    assert (folder / "mine.txt").read_text() == "keep" and (folder / "serve.py").is_file()


def test_fixed_files_are_copied_as_is(tmp_path):
    folder = make(tmp_path)
    for name in FIXED:
        assert (folder / name).read_text(encoding="utf-8") == template(name), name


def test_only_the_named_files_are_rendered(tmp_path):
    first = make(tmp_path / "a", {**OFFLINE, "retrieve": {"search": {"use": "dense", "top_k": 5}}})
    second = make(tmp_path / "b", categories_questions=SETS, source="s3://bucket/docs")
    for name in FIXED:
        assert (first / name).read_text(encoding="utf-8") == (second / name).read_text(encoding="utf-8")


def test_serve_templates_ship_in_the_wheel():
    folder = files("pandion.templates.serve")
    for name in [*FIXED, "README.md.tmpl"]:
        assert folder.joinpath(name).is_file(), name


# --- rendered files ---------------------------------------------------------------


def test_pipeline_yaml_has_version_1_source_models_and_access_off(tmp_path):
    folder = make(tmp_path)
    data = yaml_of(folder)
    assert data["version"] == 1
    assert data["source"] == {"use": "files", "location": "./docs"}
    assert data["models"] == {"download": "never", "cache_dir": "/models"}
    assert "access" not in data
    assert data["path"] == "./index"
    assert "# access:" in (folder / "pipeline.yaml").read_text(encoding="utf-8")


def test_pipeline_yaml_round_trips_through_pandion(tmp_path):
    p = pandion.Pipeline.from_yaml(make(tmp_path) / "pipeline.yaml")
    assert p.config.source[0] == "files"
    assert p.config.models.download == "never"


def test_source_bucket_goes_into_the_source_block(tmp_path):
    assert yaml_of(make(tmp_path, source="s3://acme/docs"))["source"]["location"] == "s3://acme/docs"


def test_qdrant_store_adds_its_extra_and_secret_name(tmp_path):
    folder = make(tmp_path, index_store="qdrant", index_url="https://qdrant.example.com:6333")
    store = yaml_of(folder)["index"]["store"]
    assert store["use"] == "qdrant" and store["url"] == "https://qdrant.example.com:6333"
    assert store["api_key_env"] == "QDRANT_API_KEY"
    pandion.Pipeline.from_yaml(folder / "pipeline.yaml")
    assert "qdrant" in (folder / "pyproject.toml").read_text(encoding="utf-8")
    assert "QDRANT_API_KEY=\n" in (folder / ".env.example").read_text(encoding="utf-8")


def test_a_remote_lancedb_goes_in_the_store_location(tmp_path):
    folder = make(tmp_path, index_url="s3://acme/index")
    assert yaml_of(folder)["index"]["store"]["location"] == "s3://acme/index"
    pandion.Pipeline.from_yaml(folder / "pipeline.yaml")


def test_env_example_lists_every_secret_by_name_only(tmp_path):
    chat = {**OFFLINE, "answer": {"use": "chat", "model": "claude-haiku-4-5"}}
    text = (make(tmp_path, chat) / ".env.example").read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if line and not line.startswith("#")]
    assert all(re.fullmatch(r"[A-Z_]+=", line) for line in lines)
    names = [line[:-1] for line in lines]
    assert "ANTHROPIC_API_KEY" in names and "DATABASE_URL" in names and "QDRANT_API_KEY" not in names
    assert "ANTHROPIC_API_KEY" not in (make(tmp_path / "b") / ".env.example").read_text(encoding="utf-8")


def test_pyproject_pins_pandion_and_pandion_api(tmp_path):
    text = (make(tmp_path) / "pyproject.toml").read_text(encoding="utf-8")
    assert "pandion[" in text and pin() in text
    assert f'"pandion-api{SERVE_API_PIN}"' in text
    assert "package = false" in text


def test_pyproject_has_no_jwt_dependency(tmp_path):
    text = (make(tmp_path) / "pyproject.toml").read_text(encoding="utf-8").lower()
    assert "jwt" not in text and "jose" not in text


def test_evals_is_one_file_with_category_tags(tmp_path):
    folder = make(tmp_path, categories_questions=SETS)
    assert sorted(p.name for p in (folder / "evals").iterdir()) == ["questions.json"]
    questions = json.loads((folder / "evals" / "questions.json").read_text(encoding="utf-8"))["questions"]
    assert [(q["id"], q["tags"]) for q in questions] == [("c1", ["category:contracts"]), ("p1", ["category:policies"])]
    assert questions[1]["document"] == "hr.pdf"


def test_category_with_no_questions_adds_nothing(tmp_path):
    folder = make(tmp_path, categories_questions={"contracts": {"questions": []}})
    assert not (folder / "evals").exists()
    assert not (make(tmp_path / "b") / "evals").exists()


def test_no_secret_and_no_absolute_path_in_any_file(tmp_path):
    here = {**OFFLINE, "path": "C:/Users/someone/work/index"}
    folder = make(tmp_path, here, source="C:/Users/someone/docs", categories_questions=SETS)
    for path in folder.rglob("*"):
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            assert "someone" not in text and "sk-" not in text, path.name
            assert not re.search(r"[A-Za-z]:[\\/]Users", text), path.name
    assert yaml_of(folder)["source"]["location"] == "./docs"
    secret = {**OFFLINE, "answer": {"use": "chat", "model": "custom", "model_name": "m", "custom_base_url": "https://u:p@example.com/v1"}}
    with pytest.raises(ValueError, match="user name or password"):
        make(tmp_path / "c", secret)


def test_plugins_are_refused_as_in_the_laptop_project(tmp_path):
    with pytest.raises(ValueError, match="plugins"):
        make(tmp_path, {**OFFLINE, "plugins": ["my_plugin"]})
