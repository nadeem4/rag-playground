"""The example in examples/pandion-api runs, so its README cannot go out of date.

run_pipeline.py's steps run against serve.py's app in-process, through
FastAPI's TestClient: no port and no download (the pipeline uses the fake
embedder), in a temporary folder.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from fastapi.testclient import TestClient

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "pandion-api"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"pandion_api_example_{name}", EXAMPLE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_run_pipeline_validates_uploads_indexes_asks_and_evaluates(tmp_path, capsys):
    app = _load("serve").make_app(tmp_path / "data")

    with TestClient(app) as client:
        summary = _load("run_pipeline").main(client)

    assert summary["valid"] is True
    assert len(summary["document"]) == 64  # the upload's sha256
    assert summary["index"]["status"] == "finished" and summary["index"]["ok"] is True
    assert summary["hits"], "the question found nothing"
    assert summary["evaluation"]["scored"] == summary["evaluation"]["total"] > 0
    out = capsys.readouterr().out
    for line in ("The pipeline is valid.", "Uploaded chunking-primer.pdf", "Indexed", "Hit 1", "Found"):
        assert line in out, out
    # An evaluation prints one line per question, not every search step.
    assert "  1 of 12 two-steps:" in out, out
    evaluating = out[out.index("Evaluating"):]
    assert "search ran" not in evaluating, evaluating


def test_a_template_pair_brings_its_pipeline_and_its_sample():
    import pandion

    config, pdf, questions, question = _load("run_pipeline").choose(("tables", "precision"))

    assert config == {k: v for k, v in pandion.compose_template("tables", "precision").items() if k != "path"}
    assert pdf.name == "table-of-figures.pdf" and questions.parent == pdf.parent
    assert question == "How many readers lost their place before and after the reset?"


def test_a_template_that_needs_a_key_is_refused():
    import pytest

    with pytest.raises(SystemExit, match="Chat answer needs an API key"):
        _load("run_pipeline").choose(("text", "chat"))


def _upload(app, tmp_path):
    pdf = EXAMPLE.parents[1] / "samples" / "chunking-primer" / "chunking-primer.pdf"
    with TestClient(app) as client, pdf.open("rb") as f:
        return client.post("/api/v2/documents", files={"file": (pdf.name, f, "application/pdf")})


def test_policy_example_refuses_a_big_document(tmp_path):
    app = _load("policy_example").make_app(tmp_path / "data", max_bytes=1000)

    refused = _upload(app, tmp_path)

    assert refused.status_code == 413
    assert "1000" in refused.json()["detail"]


def test_policy_example_accepts_a_small_document(tmp_path):
    app = _load("policy_example").make_app(tmp_path / "data", max_bytes=50 * 1024 * 1024)

    assert _upload(app, tmp_path).status_code == 200


def test_serve_policy_example_accepts_a_good_token_and_refuses_a_bad_one():
    from types import SimpleNamespace

    import pytest
    from fastapi import HTTPException

    module = _load("serve_policy")
    policy = module.GatewayPolicy(b"secret")

    def request(token):
        return SimpleNamespace(headers={"authorization": f"Bearer {token}"})

    good = request(module.sign(b"secret", {"sub": "ann", "roles": ["hr"]}))
    assert (policy.user_id(good), policy.roles(good)) == ("ann", ["hr"])
    for bad in (request(module.sign(b"other", {"sub": "ann"})), request("junk"), SimpleNamespace(headers={})):
        with pytest.raises(HTTPException) as caught:
            policy.limit(bad)
        assert caught.value.status_code == 401
