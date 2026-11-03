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


def test_the_access_example_in_pipeline_yaml_is_valid_when_uncommented(tmp_path):
    text = (make(tmp_path) / "pipeline.yaml").read_text(encoding="utf-8")
    block = [line[2:] for line in text.splitlines() if line.startswith("# ") and line[2:].startswith(("access:", "  "))]
    pandion.Pipeline.from_dict({**yaml.safe_load(text), **yaml.safe_load("\n".join(block))})


def test_pipeline_yaml_round_trips_through_pandion(tmp_path):
    p = pandion.Pipeline.from_yaml(make(tmp_path) / "pipeline.yaml")
    assert p.config.source[0] == "files"
    assert p.config.models.download == "never"


def test_source_bucket_goes_into_the_source_block(tmp_path):
    assert yaml_of(make(tmp_path, source="s3://acme/docs"))["source"]["location"] == "s3://acme/docs"


def test_qdrant_store_adds_its_extra_and_secret_name(tmp_path):
    folder = make(tmp_path, index_store="qdrant", index_url="https://qdrant.example.com:6333")
    store = yaml_of(folder)["index"]["store"]
    assert store["use"] == "qdrant"
    assert store["settings"] == {"url": "https://qdrant.example.com:6333", "api_key_env": "QDRANT_API_KEY"}
    pandion.Pipeline.from_yaml(folder / "pipeline.yaml")
    assert "qdrant" in (folder / "pyproject.toml").read_text(encoding="utf-8")
    assert "QDRANT_API_KEY=\n" in (folder / ".env.example").read_text(encoding="utf-8")


def test_a_remote_lancedb_is_refused_with_the_way_out(tmp_path):
    with pytest.raises(ValueError, match="qdrant"):
        make(tmp_path, index_url="s3://acme/index")
    with pytest.raises(ValueError, match="index_store"):
        make(tmp_path, index_store="mongo")


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


# --- fixed templates, init --serve and goldens ------------------------------------------


def test_dockerfile_pins_base_by_digest_and_builds_frozen(tmp_path):
    text = (make(tmp_path) / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r"^FROM python:3\.13-slim@sha256:[0-9a-f]{64}$", text, re.M)
    assert re.search(r"--from=ghcr\.io/astral-sh/uv:[\d.]+@sha256:[0-9a-f]{64} ", text)
    assert "uv sync --frozen" in text and "COPY pyproject.toml uv.lock" in text
    assert "HF_HOME=/models/hf" in text and text.index("HF_HOME=/models/hf") < text.index("RUN pandion models pull pipeline.yaml")
    assert text.index("RUN pandion models pull") < text.index("USER app")
    assert text.count("--workers") == 1 and '"1"' in text


def test_dockerignore_excludes_secrets_and_index(tmp_path):
    lines = (make(tmp_path) / ".dockerignore").read_text(encoding="utf-8").split()
    assert {".env", "docs/", "index/", ".venv"} <= set(lines)


def test_gitignore_excludes_env_index_sqlite(tmp_path):
    lines = (make(tmp_path) / ".gitignore").read_text(encoding="utf-8").split()
    assert {".env", "index/", "*.sqlite"} <= set(lines)


def policy_module(folder: Path):
    import importlib.util

    pytest.importorskip("pandion_api")
    spec = importlib.util.spec_from_file_location("generated_policy", folder / "policy.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeRequest:
    def __init__(self, **headers):
        self.headers = {k.replace("_", "-"): v for k, v in headers.items()}


def test_policy_user_id_reads_the_header_and_refuses_without_it(tmp_path, monkeypatch):
    from fastapi import HTTPException

    policy = policy_module(make(tmp_path)).GatewayPolicy()
    monkeypatch.delenv("USER_ID_HEADER", raising=False)
    assert policy.user_id(FakeRequest(x_user_id="ann")) == "ann"
    for request in (FakeRequest(), FakeRequest(x_user_id="  ")):
        with pytest.raises(HTTPException) as refused:
            policy.user_id(request)
        assert refused.value.status_code == 401
        with pytest.raises(HTTPException):
            policy.limit(request)
    monkeypatch.setenv("USER_ID_HEADER", "x-employee")
    assert policy.user_id(FakeRequest(x_employee="bo")) == "bo"
    monkeypatch.setenv("USER_ID_HEADER", "")  # an empty value in an env file means the default
    assert policy.user_id(FakeRequest(x_user_id="ann")) == "ann"


def test_policy_stub_has_the_fill_this_in_comment(tmp_path):
    folder = make(tmp_path)
    text = (folder / "policy.py").read_text(encoding="utf-8")
    assert "Fill this in from your identity system" in text
    assert "jwt" not in text.lower() and "jwks" not in text.lower()
    assert policy_module(folder).GatewayPolicy().roles(FakeRequest(x_user_id="ann")) == []


def test_cli_init_serve_writes_the_serve_project(tmp_path, capsys):
    from pandion import cli

    folder = tmp_path / "project"
    assert cli.main(["init", str(folder), "--index", "text", "--query", "balanced", "--serve"]) == 0
    assert (folder / "serve.py").is_file() and (folder / "Dockerfile").is_file()
    assert not (folder / "run.py").exists()
    out = capsys.readouterr().out
    assert "uv lock" in out and "docker build" in out and "pandion sync" in out


def pins_hidden(text: str) -> str:
    return text.replace(pin(), "~=<pin>").replace(SERVE_API_PIN, "~=<api-pin>")


def golden_text(folder: Path) -> str:
    def part(name: str) -> str:
        return f"=== {name}\n" + pins_hidden((folder / name).read_text(encoding="utf-8"))

    readme = (folder / "README.md").read_text(encoding="utf-8").split("\n## ", 1)[0]
    return "".join(part(n) for n in ("pipeline.yaml", "pyproject.toml", ".env.example", "Dockerfile")) + "=== README.md (head)\n" + readme + "\n"


@pytest.mark.parametrize(("index", "query"), [("manuals", "chat"), ("text", "balanced")])
def test_serve_goldens_match(tmp_path, index, query):
    folder = tmp_path / "project"
    pandion.new_project(folder, pandion.compose_template(index, query), kind="serve")
    golden = GOLDEN / f"{index}-{query}.txt"
    actual = golden_text(folder)
    if UPDATE:
        golden.parent.mkdir(parents=True, exist_ok=True)
        golden.write_text(actual, encoding="utf-8", newline="\n")
    assert actual == golden.read_text(encoding="utf-8")
