"""The terminal run shown on the Home page gives the figures it shows.

Home (playground/frontend/src/routes/Home.tsx) shows a `pandion init` run on the
chunking primer: it ends with the two result lines asserted below. This test does
what that run does, without `pip install` (the environment already has Pandion):
it makes the project from the Text documents and Balanced templates with the
primer's questions, copies the PDF into docs/, and runs run.py. It loads models,
so it runs in Release checks (`pytest -m models`) on Linux, which is the source
of truth for model output. If it fails, fix Home, not the test.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import pandion

SAMPLE = Path(__file__).resolve().parents[2] / "samples" / "chunking-primer"

# These two lines must match the terminal run in Home.tsx.
HOME_LINES = (
    "kept-whole missed. Lost at Rerank. cross_encoder dropped piece 19.",
    "Found 11 of 12 (92%). Mean reciprocal rank 0.92.",
)


@pytest.mark.models
def test_the_home_terminal_run_gives_the_figures_home_shows(tmp_path):
    folder = tmp_path / "my-rag"
    config = {**pandion.compose_template("text", "balanced"), "models": {"device": "cpu"}}
    pandion.new_project(folder, config, SAMPLE / "questions.json")
    shutil.copy(SAMPLE / "chunking-primer.pdf", folder / "docs")

    out = subprocess.run(
        [sys.executable, "run.py"], cwd=folder, capture_output=True, text=True, encoding="utf-8", timeout=1800
    )

    assert out.returncode == 0, out.stderr
    for line in HOME_LINES:
        assert line in out.stdout, out.stdout
