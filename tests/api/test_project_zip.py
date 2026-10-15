"""POST /api/project.zip: the pipeline on Build as a ready-to-run project zip.

The route calls `pandion.new_project` into a temporary folder, zips it in
memory and removes the folder. Nothing from the data folder, no key and no
server path ever goes into the zip.
"""

from __future__ import annotations

import io
import json
import re
import tempfile
import zipfile
from pathlib import Path

import pytest

import pandion
from playground.backend.policy import MAX_OUTPUT_TOKENS, scrub_paths
from playground.backend.routes import project
from tests.api.conftest import upload_pdf

ROUTE = "/api/project.zip"
FILES = {"README.md", "pipeline.yaml", "run.py", "requirements.txt", "docs/.gitkeep"}


def config(query: str = "balanced") -> dict:
    """A pipeline as the page sends it: the file's shape without a path."""
    c = pandion.compose_template("text", query)
    c.pop("path")
    return c


def questions(n: int = 2) -> dict:
    return {
        "version": 1,
        "document": "primer.pdf",
        "questions": [
            {"id": f"q{i}", "question": f"Question {i}?", "gold_answers": [f"answer {i}"], "tags": [], "document": "primer.pdf"}
            for i in range(n)
        ],
    }


def unzip(r) -> dict[str, str]:
    """The zip's files by their path under the top folder, as text."""
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        top = {n.split("/", 1)[0] for n in names}
        assert len(top) == 1, names
        return {n.split("/", 1)[1]: z.read(n).decode("utf-8") for n in names}


@pytest.fixture
def temp_root(tmp_path, monkeypatch) -> Path:
    """Python's temp folder, moved where the test can see what is left in it."""
    root = tmp_path / "temp"
    root.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(root))
    return root


def test_the_zip_holds_exactly_the_project_files(client):
    r = client.post(ROUTE, json={"config": config(), "name": "Manuals, cross-encoder"})

    files = unzip(r)
    assert set(files) == FILES
    assert r.headers["content-disposition"] == 'attachment; filename="manuals-cross-encoder.zip"'
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        assert all(n.startswith("manuals-cross-encoder/") for n in z.namelist())
    assert files["README.md"].startswith("# manuals-cross-encoder\n")
    assert pandion.Pipeline.from_dict(__import__("yaml").safe_load(files["pipeline.yaml"]))


def test_with_questions_the_zip_also_holds_them(client):
    files = unzip(client.post(ROUTE, json={"config": config(), "name": "x", "questions": questions(3)}))

    assert set(files) == FILES | {"questions.json"}
    assert len(json.loads(files["questions.json"])["questions"]) == 3
    assert "primer.pdf" in files["README.md"]


def test_a_pipeline_without_a_name_gets_a_plain_one(client):
    r = client.post(ROUTE, json={"config": config()})

    unzip(r)
    assert r.headers["content-disposition"] == 'attachment; filename="rag-pipeline.zip"'
    assert project.slug("  Ünïcode / ../.. Pipeline!!  ") == "unicode-pipeline"
    assert project.slug("...") == "rag-pipeline"
    assert len(project.slug("a" * 300)) <= 60


def test_no_absolute_path_is_in_any_file(client, dirs, tmp_path):
    c = config()
    c["path"] = str(tmp_path / "secret-index")
    c["models"] = {"cache_dir": str(dirs["artifacts"] / "models"), "device": "cpu"}
    c["index"]["parse"]["note"] = "C:\\Users\\me\\private\\a.pdf"  # an unknown setting: refused, see below

    r = client.post(ROUTE, json={"config": c, "name": "paths"})
    assert r.status_code == 400  # an unknown setting is a ConfigError
    c["index"]["parse"].pop("note")

    files = unzip(client.post(ROUTE, json={"config": c, "name": "paths"}))
    for name, text in files.items():
        assert str(tmp_path) not in text and tmp_path.as_posix() not in text, name
        assert scrub_paths(text) == text, name
    assert "path: ./pandion-index" in files["pipeline.yaml"]
    assert "models:" not in files["pipeline.yaml"]


def test_the_pipeline_dict_is_scrubbed_before_new_project(client, monkeypatch, tmp_path):
    seen = {}
    real = pandion.new_project

    def spy(folder, pipeline, *args, **kwargs):
        seen["pipeline"] = json.dumps(pipeline)
        return real(folder, pipeline, *args, **kwargs)

    monkeypatch.setattr(project.pandion, "new_project", spy)
    c = config()
    c["index"]["store"]["table"] = f"{tmp_path}/table"  # not a real setting: a path in a string value

    client.post(ROUTE, json={"config": c, "name": "x"})
    assert str(tmp_path) not in seen["pipeline"] and tmp_path.as_posix() not in seen["pipeline"]


def test_no_key_is_in_any_file(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-the-environment")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-from-the-environment")
    body = {"config": config("chat"), "name": "keys", "credentials": {"anthropic_api_key": "sk-ant-in-the-body"}}

    r = client.post(ROUTE, json=body, headers={"X-Anthropic-Api-Key": "sk-ant-in-a-header"})

    files = unzip(r)
    for name, text in files.items():
        assert "sk-ant" not in text and "sk-openai" not in text, name
    assert "ANTHROPIC_API_KEY" in files["README.md"]


def test_no_uploaded_document_or_data_file_is_included(client, dirs):
    doc = upload_pdf(client, "mine.pdf")

    r = client.post(ROUTE, json={"config": config(), "name": "x", "questions": questions()})

    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = z.namelist()
        assert not any(n.lower().endswith(".pdf") for n in names)
        assert not any(z.read(n).startswith(b"%PDF") for n in names if not n.endswith("/"))
    files = unzip(r)
    assert doc["sha"] not in "".join(files.values())
    assert [n for n in files if n.startswith("docs/")] == ["docs/.gitkeep"]


def demo_config() -> dict:
    """A pipeline with the LLM reranker's text budget at the demo's cap (four times its default)."""
    c = config("balanced")
    c["retrieve"]["rerank"] = [{"use": "llm_rerank", "text_budget_chars": 2400}]
    return c


def test_the_readme_lists_the_settings_the_demo_limited_and_the_scores(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    body = {"config": demo_config(), "name": "x", "scores": "11 of 12 found, MRR 0.88"}

    readme = unzip(client.post(ROUTE, json=body))["README.md"]

    assert "## Settings the demo limited" in readme
    assert "`retrieve.rerank.1.text_budget_chars` is 2400, the most the demo allows." in readme
    assert "## Scores to beat" in readme
    assert "11 of 12 found, MRR 0.88" in readme


def test_the_readme_has_neither_section_when_nothing_was_given_or_capped(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    c = config("chat")
    c["answer"]["max_tokens"] = MAX_OUTPUT_TOKENS  # its default: the demo took nothing away

    readme = unzip(client.post(ROUTE, json={"config": c, "name": "x", "scores": "   "}))["README.md"]

    assert "Settings the demo limited" not in readme
    assert "Scores to beat" not in readme


def test_locally_nothing_is_listed_as_limited(client):
    readme = unzip(client.post(ROUTE, json={"config": demo_config(), "name": "x"}))["README.md"]

    assert "Settings the demo limited" not in readme


def test_the_scores_are_one_short_line(client):
    scores = "11 of 12 found\n\n# Not a heading " + "x" * 1000

    readme = unzip(client.post(ROUTE, json={"config": config(), "name": "x", "scores": scores}))["README.md"]

    line = next(line for line in readme.splitlines() if "11 of 12 found" in line)
    assert "\n# Not a heading" not in readme
    assert len(line) <= project.MAX_SCORES_CHARS + 120


@pytest.mark.parametrize(
    ("change", "words"),
    [
        (lambda c: c.update(plugins=["my_steps"]), "plugin"),
        (lambda c: c["index"]["parse"].update(use="no-such-parser"), "no-such-parser"),
        (
            lambda c: c.update(
                answer={"use": "chat", "model": "custom", "custom_base_url": "https://me:pw@example.com/v1", "custom_model": "m"}
            ),
            "user name or password",
        ),
    ],
)
def test_a_bad_pipeline_is_a_400_with_a_plain_sentence(client, change, words):
    c = config()
    change(c)

    r = client.post(ROUTE, json={"config": c, "name": "x"})

    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, str) and words in detail
    assert "Traceback" not in detail


def test_a_config_that_is_not_a_mapping_is_a_400(client):
    r = client.post(ROUTE, json={"config": ["not", "a", "mapping"]})

    assert r.status_code == 400
    assert r.json()["detail"] == "The pipeline must be a mapping of settings, in the pipeline file's shape."


def test_a_bad_question_set_is_a_400(client):
    r = client.post(ROUTE, json={"config": config(), "questions": {"questions": []}})

    assert r.status_code == 400
    assert "question" in r.json()["detail"]


def test_a_request_over_the_size_cap_is_refused(client):
    body = json.dumps({"config": config(), "scores": "x" * (project.MAX_BODY_BYTES + 1)})

    r = client.post(ROUTE, content=body, headers={"Content-Type": "application/json"})

    assert r.status_code == 413


def test_the_question_caps_hold(client, monkeypatch):
    r = client.post(ROUTE, json={"config": config(), "questions": questions(501)})
    assert r.status_code == 400
    assert "500" in r.json()["detail"]

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    r = client.post(ROUTE, json={"config": config(), "questions": questions(51)})
    assert r.status_code == 413
    assert r.json()["detail"] == (
        "The demo packs at most 50 questions into a project, and this set has 51. "
        "Leave the questions out, or run the playground locally to take them all."
    )


def test_the_preview_says_how_many_questions_a_project_may_hold(client, monkeypatch):
    assert client.post(f"{ROUTE}?preview=1", json={"config": config()}).json()["max_questions"] is None

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert client.post(f"{ROUTE}?preview=1", json={"config": config()}).json()["max_questions"] == 50


def test_an_over_cap_setting_is_not_listed_as_limited(monkeypatch):
    from playground.backend.policy import demo_limited

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    c = demo_config()
    c["retrieve"]["rerank"][0]["text_budget_chars"] = 2401

    assert demo_limited(c) == []


def test_a_malformed_pipeline_is_a_plain_400(client):
    r = client.post(ROUTE, json={"config": {**config(), "retrieve": [1]}, "name": "x"})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == project.MALFORMED

    r = client.post(ROUTE, json={"config": {**config(), "answer": [1]}, "name": "x"})
    assert r.status_code == 400, r.text
    assert r.json()["detail"].startswith("answer must")


def test_the_temporary_folder_is_removed(client, temp_root):
    unzip(client.post(ROUTE, json={"config": config(), "name": "x"}))
    assert list(temp_root.iterdir()) == []

    r = client.post(ROUTE, json={"config": {**config(), "plugins": ["x"]}, "name": "x"})
    assert r.status_code == 400
    assert list(temp_root.iterdir()) == []

    client.post(f"{ROUTE}?preview=1", json={"config": config(), "name": "x"})
    assert list(temp_root.iterdir()) == []


def test_the_preview_is_the_zips_text_as_json(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    body = {"config": demo_config(), "name": "My pipeline", "questions": questions(), "scores": "2 of 2 found"}

    preview = client.post(f"{ROUTE}?preview=1", json=body)
    files = unzip(client.post(ROUTE, json=body))

    assert preview.status_code == 200
    data = preview.json()
    assert data["filename"] == "my-pipeline.zip"
    assert data["files"] == files
    assert data["limited"] == [{"setting": "retrieve.rerank.1.text_budget_chars", "value": 2400, "cap": 2400}]
    assert data["keys"] == [{"variable": "ANTHROPIC_API_KEY", "optional": False}]


def test_the_preview_names_no_key_for_a_pipeline_that_needs_none(client):
    data = client.post(f"{ROUTE}?preview=1", json={"config": config()}).json()

    assert data["keys"] == []
    assert data["limited"] == []
    assert re.search(r"needs no API key", data["files"]["README.md"])
