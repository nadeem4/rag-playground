"""The example in examples/pandion runs, so the guide's example cannot go out of date.

It uses the fake embedder, so nothing is downloaded, and a temporary folder.
The rewrite example runs with a fake model, so no call leaves the machine.
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


def test_rewrite_example_without_a_key_shows_the_question_as_typed(capsys):
    typed, rewritten = _load_script("rewrite_question").main("How big should a piece be?")

    assert typed.output.text == "How big should a piece be?" and rewritten is None
    assert "ANTHROPIC_API_KEY" in capsys.readouterr().out


def test_rewrite_example_with_a_key_shows_the_models_rewrite(monkeypatch, capsys):
    """A fake model: no call leaves the machine."""
    from pandion import llm

    calls: list[dict] = []

    def fake(model, **kwargs):
        calls.append({"model": model.id, **kwargs})
        return llm.Completion(text="chunk size tokens characters", usage={}, stop_reason="end_turn")

    monkeypatch.setattr(llm, "complete", fake)
    _, rewritten = _load_script("rewrite_question").main("How big should a piece be?", "sk-test")

    assert rewritten.output.text == "chunk size tokens characters"
    assert rewritten.output.asked == "How big should a piece be?"
    assert calls[0]["model"] == "claude-haiku-4-5" and calls[0]["api_key"] == "sk-test"
    assert "The document begins" in calls[0]["user"]
    assert "Rewritten: chunk size tokens characters" in capsys.readouterr().out


def test_search_example_finds_hits_then_reuses_every_step(tmp_path, capsys):
    first, second = _load_script("search_samples").main(tmp_path, embedder="fake-deterministic")

    assert first.ok and second.ok
    assert len(first.hits) == 5
    assert [s.transform for s in first.stages["rerank"]] == ["mmr"]
    steps = [second.stages["rewrite"], second.stages["search"], *second.stages["rerank"]]
    assert all(s.status == "cached" for s in steps)
    assert [h.chunk.id for h in second.hits] == [h.chunk.id for h in first.hits]
    assert "3 of 3 steps reused" in capsys.readouterr().out


def test_example_pipeline_file_searches_with_hybrid_then_mmr():
    from pandion import Pipeline

    retrieve = Pipeline.from_file(EXAMPLE / "pipeline.yaml").config.retrieve
    assert retrieve.rewrite is None
    assert retrieve.search[0] == "hybrid_rrf"
    assert [use for use, _ in retrieve.rerank] == ["mmr"]
