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
