"""The quality gate: the stale check, then the gate against evals/baseline.json.

`pandion eval` checks first that every expected passage is still in its
document, and only then searches and compares with the baseline. Record the
baseline once with the built image (README.md, "The quality gate").
"""

import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent


def test_quality_gate():
    if not (HERE / "evals" / "baseline.json").is_file():
        pytest.fail("evals/baseline.json is missing. Record it with the built image: see README.md, 'The quality gate'.")
    done = subprocess.run(
        [sys.executable, "-m", "pandion.cli", "eval", "pipeline.yaml", "evals/questions.json", "--baseline", "evals/baseline.json"],
        cwd=HERE, capture_output=True, text=True, encoding="utf-8",
    )
    assert done.returncode == 0, done.stderr + done.stdout
