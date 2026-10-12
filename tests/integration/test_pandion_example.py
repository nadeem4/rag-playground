"""The example in examples/pandion runs, so the guide's example cannot go out of date.

It uses the fake embedder, so nothing is downloaded, and a temporary folder.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "pandion"


def _load_script(name: str = "index_samples"):
    spec = importlib.util.spec_from_file_location(name, EXAMPLE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sync_example_adds_then_removes_a_sample(tmp_path, capsys):
    first, added, removed = _load_script("sync_samples").main(tmp_path, embedder="fake-deterministic")

    assert first.ok and added.ok and removed.ok
    assert first.added == ["chunking-primer.pdf", "two-column-report.pdf"]
    assert added.added == ["table-of-figures.pdf"]
    assert added.unchanged == ["chunking-primer.pdf", "two-column-report.pdf"]
    assert removed.removed == ["table-of-figures.pdf"]
    assert removed.index.artifact_id == first.index.artifact_id
    assert "removed: table-of-figures.pdf" in capsys.readouterr().out


def test_example_indexes_two_samples_then_reuses_everything(tmp_path, capsys):
    first, second = _load_script().main(tmp_path, embedder="fake-deterministic")

    assert first.ok and second.ok
    assert sorted(first.documents) == ["chunking-primer.pdf", "two-column-report.pdf"]
    first_steps = [s for d in first.documents.values() for s in d.stages.values()]
    assert all(s.status == "executed" for s in [*first_steps, first.index])
    second_steps = [s for d in second.documents.values() for s in d.stages.values()]
    assert all(s.status == "cached" for s in [*second_steps, second.index])
    assert second.index.artifact_id == first.index.artifact_id
    assert "reused" in capsys.readouterr().out


def test_example_pipeline_file_is_a_valid_pipeline():
    from pandion import Pipeline

    config = Pipeline.from_file(EXAMPLE / "pipeline.yaml").config
    assert config.index.parse[0] == "pdfium"
    assert config.index.store["embedder"] == "qwen3-embedding-0.6b"
