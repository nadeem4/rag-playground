"""The boot check: a generated serve project starts, syncs, answers and passes its own quality test.

No network and no model: the fake embedder and `answer: {use: search}`. The
project's serve.py is imported from its folder with this repo's environment (no
`uv sync`, because pandion-api is not on PyPI yet), and a real `pandion sync`
fills its index.
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import pandion
from pandion import cli
from pdfs import SAMPLE_PAGES, build_pdf
from test_serve_project import OFFLINE

pytest.importorskip("pandion_api")
from fastapi.testclient import TestClient  # noqa: E402
from pandion_api import ApiSettings, Policy  # noqa: E402

QUESTIONS = {
    "geo": {"questions": [{"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}]},
}
ASK = {"question": "What is the capital of France?"}


def build_project(folder: Path) -> Path:
    pandion.new_project(folder, OFFLINE, kind="serve", categories_questions=QUESTIONS)
    (folder / "docs").mkdir()
    (folder / "docs" / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return folder


@pytest.fixture
def project(tmp_path) -> Path:
    """A fresh project, for a test that changes it."""
    return build_project(tmp_path / "project")


@pytest.fixture(scope="module")
def synced(tmp_path_factory) -> Path:
    """One synced project shared by the tests that only read it."""
    folder = build_project(tmp_path_factory.mktemp("synced") / "project")
    assert cli.main(["sync", str(folder / "pipeline.yaml")]) == 0
    return folder


def load_serve(folder: Path):
    """The project's serve.py as a module. It imports policy.py by name, so the folder is on sys.path while it loads."""
    sys.path.insert(0, str(folder))
    try:
        spec = importlib.util.spec_from_file_location("generated_serve", folder / "serve.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(folder))
        sys.modules.pop("policy", None)


def app_for(folder: Path, policy=None):
    return load_serve(folder).make_app(policy=policy or Policy.anonymous(), settings=ApiSettings(data_dir=folder / "index"))


def sync(folder: Path) -> int:
    return cli.main(["sync", str(folder / "pipeline.yaml")])


def pandion_cli(folder: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "pandion.cli", *args], cwd=folder, capture_output=True, text=True, encoding="utf-8", timeout=600
    )


def test_boot_check_ready_only_after_sync(project):
    with TestClient(app_for(project)) as client:
        assert client.get("/health").status_code == 200
        before = client.get("/ready")
        assert before.status_code == 503 and before.json() == {"ready": False}
        assert sync(project) == 0
        assert client.get("/ready").json() == {"ready": True}


def test_chat_answers_after_sync(synced):
    with TestClient(app_for(synced)) as client:
        reply = client.post("/chat", json={"messages": [{"role": "user", "content": ASK["question"]}]})
        assert reply.status_code == 200 and reply.json()["ok"] is True
        assert reply.json()["sources"]
        streamed = client.post("/chat", json={"messages": [{"role": "user", "content": ASK["question"]}], "stream": True})
        assert streamed.status_code == 200
        assert '"event": "sources"' in streamed.text and '"event": "done"' in streamed.text


def test_the_default_server_app_refuses_a_request_without_a_user(synced):
    sys.path.insert(0, str(synced))
    try:
        spec = importlib.util.spec_from_file_location("generated_serve_default", synced / "serve.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(synced))
        sys.modules.pop("policy", None)
    with TestClient(module.app) as client:
        assert client.post("/ask", json=ASK).status_code == 401
        assert client.post("/ask", json=ASK, headers={"x-user-id": "ann"}).status_code in (200, 503)


def test_default_policy_returns_no_roles_so_nothing_is_visible(project):
    pipeline = yaml.safe_load((project / "pipeline.yaml").read_text(encoding="utf-8"))
    pipeline["access"] = {"default": ["staff"]}
    (project / "pipeline.yaml").write_text(yaml.safe_dump(pipeline, sort_keys=False), encoding="utf-8")
    assert sync(project) == 0
    module = load_serve(project)
    settings = ApiSettings(data_dir=project / "index")
    user = {"x-user-id": "ann"}

    with TestClient(module.make_app(settings=settings)) as client:  # the template policy: roles() returns []
        seen = client.post("/ask", json=ASK, headers=user).json()
        assert seen["sources"] == []

    class Staff(module.GatewayPolicy):
        def roles(self, request):
            return ["staff"]

    with TestClient(module.make_app(policy=Staff(), settings=settings)) as client:
        assert client.post("/ask", json=ASK, headers=user).json()["sources"]


def test_quality_runs_stale_check_before_the_gate(project):
    assert sync(project) == 0
    assert pandion_cli(project, "eval", "pipeline.yaml", "evals/questions.json", "--record-baseline", "evals/baseline.json").returncode == 0
    quality = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_quality.py"]
    assert subprocess.run(quality, cwd=project, capture_output=True, text=True, timeout=600).returncode == 0

    questions = project / "evals" / "questions.json"
    data = json.loads(questions.read_text(encoding="utf-8"))
    data["questions"][0]["gold_answers"] = ["Madrid is the capital of Spain."]
    questions.write_text(json.dumps(data), encoding="utf-8")
    stale = subprocess.run(quality, cwd=project, capture_output=True, text=True, timeout=600)
    assert stale.returncode != 0
    assert "The question set is stale" in stale.stdout and "not a retrieval regression" in stale.stdout


def test_quality_fails_with_a_sentence_when_the_baseline_is_missing(synced):
    done = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_quality.py"],
        cwd=synced, capture_output=True, text=True, timeout=600,
    )
    assert done.returncode != 0 and "evals/baseline.json is missing" in done.stdout


def test_a_deleted_collection_makes_ready_false_again(project):
    import shutil

    with TestClient(app_for(project)) as client:
        assert sync(project) == 0
        assert client.get("/ready").json() == {"ready": True}
        shutil.rmtree(project / "index" / "index")
        assert client.get("/ready").status_code == 503
