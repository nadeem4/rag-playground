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
    assert config.index.default.parse[0] == "pdfium"
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


def test_ask_example_shows_the_pieces_found_then_reuses_every_step(tmp_path, capsys):
    first, second = _load_script("ask_samples").main(tmp_path, embedder="fake-deterministic")

    assert first.ok and second.ok
    assert first.output.kind == "search" and len(first.output.payload["results"]) == 3
    assert first.stages["answer"].transform == "search"
    assert second.stages["answer"].status == "cached"
    assert second.output == first.output
    out = capsys.readouterr().out
    assert "answer (search): executed" in out and "ANTHROPIC_API_KEY" in out


def test_ask_example_with_a_key_answers_with_claude(tmp_path, monkeypatch, capsys):
    """A fake model: no call leaves the machine."""
    from types import SimpleNamespace

    from pandion.plugins.answer import chat

    calls: list[dict] = []

    def create(**request):
        calls.append(request)
        return SimpleNamespace(
            model=request["model"],
            stop_reason="end_turn",
            usage=SimpleNamespace(input_tokens=10, output_tokens=5),
            content=[SimpleNamespace(type="text", text="Pieces of a few hundred tokens.", citations=[])],
        )

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
    monkeypatch.setattr(chat, "make_client", lambda api_key: client)
    answer, _ = _load_script("ask_samples").main(tmp_path, api_key="sk-test", embedder="fake-deterministic")

    assert answer.ok and answer.output.kind == "chat"
    assert answer.text == "Pieces of a few hundred tokens."
    assert calls[0]["model"] == "claude-haiku-4-5"
    assert "Pieces of a few hundred tokens." in capsys.readouterr().out


def test_three_styles_example_gives_the_same_ids_every_way(tmp_path, capsys):
    runs = _load_script("three_styles").main(tmp_path, embedder="fake-deterministic")

    ids = {style: answer_ids(answer) for style, answer in runs.items()}
    assert set(runs) == {"yaml", "dicts", "classes"}
    assert ids["yaml"] == ids["dicts"] == ids["classes"]
    assert all(s.status == "cached" for s in all_steps(runs["classes"]))
    assert "The artifact ids match in all three." in capsys.readouterr().out


def all_steps(answer):
    return [answer.index, answer.stages["rewrite"], answer.stages["search"], *answer.stages["rerank"], answer.stages["answer"]]


def answer_ids(answer):
    return [s.artifact_id for s in all_steps(answer)]


def test_example_pipeline_file_answers_with_search():
    from pandion import Pipeline

    assert Pipeline.from_yaml(EXAMPLE / "pipeline.yaml").config.answer == ("search", {"top_k": 3})


PRIMER = EXAMPLE.parents[1] / "samples" / "chunking-primer" / "chunking-primer.pdf"


def test_run_template_composes_two_templates_and_answers(tmp_path, capsys):
    answer = _load_script("run_template").main(
        "text", "balanced", PRIMER, "How big should a chunk be?", work=tmp_path, embedder="fake-deterministic"
    )

    assert answer.ok and answer.hits
    out = capsys.readouterr().out
    assert "Text documents with Balanced" in out and "Hit 1" in out, out


def test_run_template_without_a_key_says_which_template_needs_one(tmp_path, monkeypatch):
    import pytest

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(SystemExit, match="Chat answer needs an API key.*ANTHROPIC_API_KEY"):
        _load_script("run_template").main("text", "chat", PRIMER, work=tmp_path, embedder="fake-deterministic")
