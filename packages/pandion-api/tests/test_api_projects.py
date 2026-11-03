"""POST /projects/serve: the serve project as a preview or a zip."""

import io
import json
import zipfile

from apihelpers import PIPELINE, settings
from fastapi import HTTPException
from fastapi.testclient import TestClient

from pandion_api import Policy, create_app

CHUNK = {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10}
CONFIG = {
    "categories": {
        "contracts": {"parse": {"use": "pdfium"}, "chunk": CHUNK},
        "policies": {"parse": {"use": "pdfium"}, "chunk": CHUNK},
    },
    "route": [{"when": {"use": "name", "pattern": "pol*"}, "category": "policies"}, {"category": "contracts"}],
    "index": {"embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}},
    "retrieve": PIPELINE["retrieve"],
    "answer": PIPELINE["answer"],
}
QUESTIONS = {"questions": [{"id": "c1", "question": "Who signs?", "gold_answers": ["The buyer."]}]}
SAMPLE = {"questions": [{"id": "s1", "question": "Sample question?", "gold_answers": ["Sample."]}]}


def body(**changes):
    return {"config": CONFIG, "name": "Contracts bot", "categories": {"contracts": {"questions": QUESTIONS}}, **changes}


def preview(client, **changes):
    return client.post("/projects/serve?preview=1", json=body(**changes))


def test_serve_export_preview_lists_the_serve_files(client):
    r = preview(client)
    assert r.status_code == 200
    data = r.json()
    assert data["filename"] == "contracts-bot.zip"
    assert {"pipeline.yaml", "serve.py", "policy.py", "Dockerfile", "pyproject.toml", ".env.example",
            "README.md", "evals/questions.json"} <= set(data["files"])
    assert data["max_questions"] is None and data["keys"] == []


def test_zip_contains_the_same_files_as_the_preview(client):
    files = preview(client).json()["files"]
    r = client.post("/projects/serve", json=body())
    assert r.headers["content-type"] == "application/zip"
    assert "contracts-bot.zip" in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        assert {n.removeprefix("contracts-bot/"): z.read(n).decode() for n in z.namelist()} == files


def test_sample_questions_are_dropped_and_listed(client):
    cats = {"contracts": {"questions": QUESTIONS}, "policies": {"questions": SAMPLE, "sample": True}}
    data = preview(client, categories=cats).json()
    evals = json.loads(data["files"]["evals/questions.json"])
    assert [q["id"] for q in evals["questions"]] == ["c1"]
    assert "Sample question" not in json.dumps(data["files"])
    assert data["left_out"]["categories"] == [{"id": "policies", "reason": "sample questions only"}]


def test_category_without_questions_is_left_out(client):
    cats = {"contracts": {"questions": {"questions": []}}}
    data = preview(client, categories=cats).json()
    assert "evals/questions.json" not in data["files"]
    assert data["left_out"]["categories"] == [{"id": "contracts", "reason": "no questions"}]


def test_unknown_category_id_is_a_400_sentence(client):
    r = preview(client, categories={"nope": {"questions": QUESTIONS}})
    assert r.status_code == 400
    assert "nope" in r.json()["detail"] and "category" in r.json()["detail"]


def test_where_settings_reach_pipeline_yaml(client):
    where = {"source": "gs://bucket/docs", "index_store": "qdrant", "index_url": "https://qdrant.example.com:6333"}
    data = preview(client, where=where).json()
    text = data["files"]["pipeline.yaml"]
    assert "gs://bucket/docs" in text and "https://qdrant.example.com:6333" in text
    assert "QDRANT_API_KEY" in data["files"][".env.example"]
    assert "sk-" not in json.dumps(data["files"])


def test_remote_lancedb_index_is_a_400_sentence(client):
    r = preview(client, where={"index_store": "lancedb", "index_url": "s3://bucket/index"})
    assert r.status_code == 400
    assert "qdrant" in r.json()["detail"].lower()


def test_bad_store_name_is_a_422(client):
    assert preview(client, where={"index_store": "pinecone"}).status_code == 422


def test_no_key_from_the_request_is_written(client):
    secret = "sk-ant-api03-SECRETSECRETSECRET"
    r = client.post(
        "/projects/serve?preview=1", json=body(name=secret), headers={"x-anthropic-api-key": "sk-ant-HEADERKEY"}
    )
    text = json.dumps(r.json()["files"])
    assert "HEADERKEY" not in text and "SECRETSECRET" not in text


def test_server_paths_do_not_leak(client, tmp_path):
    config = {**CONFIG, "path": str(tmp_path / "data" / "mine"), "models": {"cache_dir": str(tmp_path / "cache")}}
    text = json.dumps(preview(client, config=config).json()["files"])
    assert str(tmp_path) not in text and tmp_path.as_posix() not in text


def test_body_over_the_cap_is_a_413(client):
    r = client.post("/projects/serve?preview=1", content=b"x" * (3 * 1024 * 1024),
                    headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_plugins_in_the_pipeline_are_a_400_sentence(client):
    r = preview(client, config={**CONFIG, "plugins": ["my.module"]})
    assert r.status_code == 400 and "plugins" in r.json()["detail"]


def test_left_out_always_lists_documents_and_lock(client):
    left = preview(client).json()["left_out"]
    assert left["documents"] is True and left["lock"] is True and left["categories"] == []


def test_question_count_goes_through_the_policy(tmp_path):
    seen = []

    class Capped(Policy):
        def check_question_count(self, kind, count, request):
            seen.append((kind, count))
            raise HTTPException(status_code=413, detail="Too many questions.")

    with TestClient(create_app(settings(tmp_path), Capped())) as client:
        r = preview(client)
    assert r.status_code == 413 and r.json()["detail"] == "Too many questions."
    assert seen == [("evaluation", 1)]
