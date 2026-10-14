"""The app's evaluations and pandion.evaluate give the same verdict.

The Evaluate page runs POST /api/v2/evaluations, and pandion-api scores each
question with pandion. The same file, settings and question must give the same
score as pandion.evaluate called directly.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

import pandion
from api.deps import build_deps
from api.main import create_app
from pandion import Pipeline
from tests.api.conftest import read_sse
from tests.steps.conftest import SAMPLE_PAGES, build_pdf

FOUND = ("What is the capital of France?", "The capital of France is Paris.")
MISSED = ("What is the capital of Spain?", "Madrid is the capital of Spain.")
CHUNK = {"chunk_size": 70, "chunk_overlap": 10}
SEARCH = {"top_k": 5}
CONFIG = {
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character", **CHUNK},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "hybrid_rrf", **SEARCH}},
}


def _both(tmp_path, question: str, gold: str) -> tuple[dict, dict]:
    """The app's score on /api/v2/evaluations and pandion.evaluate's, for one question."""
    docs = tmp_path / "docs"
    docs.mkdir()
    pdf = docs / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))

    deps = build_deps(
        artifacts_dir=tmp_path / "data" / "artifacts",
        sources_dir=tmp_path / "data" / "sources",
        web_dist=tmp_path / "web",
    )
    with TestClient(create_app(deps)) as client:
        files = {"file": ("sample.pdf", pdf.read_bytes(), "application/pdf")}
        sha = client.post("/api/v2/documents", files=files).json()["sha"]
        body = {
            "config": CONFIG,
            "documents": [sha],
            "questions": [{"question": question, "gold_answers": [gold]}],
            "top_k": 5,
        }
        run_id = client.post("/api/v2/evaluations", json=body).json()["run_id"]
        read_sse(client, run_id, prefix="/api/v2")
        state = client.get(f"/api/v2/runs/{run_id}").json()
    assert state["ok"] is True
    in_app = state["result"]["questions"][0]["score"]

    p = Pipeline(
        path=tmp_path / "pandion",
        parse="pdfium",
        chunk={"use": "recursive_character", **CHUNK},
        embed="fake-deterministic",
        store="lancedb",
        search={"use": "hybrid_rrf", **SEARCH},
    )
    report = pandion.evaluate(p, [{"question": question, "gold_answer": gold}], documents=docs)
    return in_app, report.questions[0].score


def test_the_apps_evaluation_and_pandion_evaluate_agree(tmp_path):
    in_app, score = _both(tmp_path, *FOUND)
    assert score == in_app
    assert in_app["hit"] is True and in_app["rank"] == 1


def test_they_agree_on_a_miss_too(tmp_path):
    in_app, score = _both(tmp_path, *MISSED)
    assert score == in_app
    assert in_app["hit"] is False
    for key in ("found_at", "returned", "match"):
        assert score[key] == in_app[key]
