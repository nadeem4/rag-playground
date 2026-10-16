"""llm_context: a model writes one or two sentences that place each piece in
its document, and they go in front of what is embedded.

No test calls a model: `pandion.llm.complete` is replaced by a fake that
answers from the piece it is shown.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import lancedb
import pytest

from pandion import Pipeline, llm
from pandion.artifacts import ArtifactType
from pandion.config import ConfigError, from_dict, to_dict
from pandion.llm import Completion
from pandion.payloads import Chunk, ChunkSet
from pandion.plugins import discover
from pandion.plugins.enrich.llm_context import (
    DOC_BUDGET,
    LlmContext,
    LlmContextConfig,
)
from pandion.ports import RunContext, Stage
from pandion.registry import registry
from pdfs import SAMPLE_PAGES, build_pdf

CREDS = {"anthropic_api_key": "sk-ant-test", "openai_api_key": "sk-openai-test"}


class FakeComplete:
    """Answers "About <the piece's first word>." and records every call."""

    def __init__(self, delay=None, fail_on: str | None = None):
        self.delay = delay
        self.fail_on = fail_on
        self.calls: list[dict] = []
        self.lock = threading.Lock()
        self.running = 0
        self.most_at_once = 0

    def __call__(self, model, **kwargs):
        piece = kwargs["user"].split("<piece>\n", 1)[1].split("\n</piece>", 1)[0]
        with self.lock:
            self.calls.append({"model": model, **kwargs})
            self.running += 1
            self.most_at_once = max(self.most_at_once, self.running)
        try:
            if self.delay is not None:
                time.sleep(self.delay(piece))
            if self.fail_on and self.fail_on in piece:
                raise RuntimeError("Rate limited by the Anthropic API (429). Retry shortly.")
            return Completion(
                text=f"About {piece.split()[0]}.",
                usage={"input_tokens": 100, "output_tokens": 7, "cache_read_input_tokens": 80},
                stop_reason="end_turn",
                model="claude-haiku-4-5",
            )
        finally:
            with self.lock:
                self.running -= 1


@pytest.fixture
def fake(monkeypatch):
    def install(**kwargs) -> FakeComplete:
        f = FakeComplete(**kwargs)
        monkeypatch.setattr(llm, "complete", f)
        return f

    return install


def ctx(tmp_path, creds: dict | None = CREDS) -> RunContext:
    run_ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    if creds is not None:
        run_ctx.extras["credentials"] = dict(creds)
    return run_ctx


def chunk_set(n: int = 3) -> ChunkSet:
    texts = [f"Piece{i} says something." for i in range(n)]
    source = "\n\n".join(texts)
    chunks, pos = [], 0
    for i, text in enumerate(texts):
        chunks.append(
            Chunk(
                id=f"c{i}",
                text=text,
                start_char=pos,
                end_char=pos + len(text),
                ordinal=i,
                doc_id="d",
                # The first piece already has heading_context in front.
                embed_text="Results\n\n" + text if i == 0 else None,
            )
        )
        pos += len(text) + 2
    return ChunkSet(chunks=chunks, doc_id="d", source_text=source)


def enrich(tmp_path, chunks: ChunkSet, run_ctx=None, **config) -> tuple[ChunkSet, RunContext]:
    run_ctx = run_ctx or ctx(tmp_path)
    out = LlmContext().apply({"chunks": chunks}, LlmContextConfig(**config), run_ctx)
    return ChunkSet.model_validate(out), run_ctx


# -- declarations ---------------------------------------------------------------


def test_it_is_registered_as_a_cacheable_enrich_step():
    discover()
    cls = registry.get(Stage.ENRICH, "llm_context")
    assert cls is LlmContext
    assert cls.output == ArtifactType.CHUNK_SET
    assert cls.cacheable is True and cls.deterministic is False


def test_the_prompt_is_read_only():
    schema = LlmContextConfig.model_json_schema()
    assert schema["properties"]["prompt"]["readOnly"] is True


# -- what it writes ---------------------------------------------------------------


def test_each_piece_gets_its_context_in_front_of_what_is_embedded(tmp_path, fake):
    calls = fake()
    out, _ = enrich(tmp_path, chunk_set())
    first, second, third = out.chunks
    assert first.embed_text == "About Piece0.\n\nResults\n\nPiece0 says something."
    assert second.embed_text == "About Piece1.\n\nPiece1 says something."
    assert third.embed_text == "About Piece2.\n\nPiece2 says something."
    assert len(calls.calls) == 3


def test_ids_text_and_offsets_do_not_change(tmp_path, fake):
    fake()
    before = chunk_set()
    out, _ = enrich(tmp_path, before)
    assert [(c.id, c.text, c.start_char, c.end_char) for c in out.chunks] == [
        (c.id, c.text, c.start_char, c.end_char) for c in before.chunks
    ]
    assert out.source_text == before.source_text


def test_the_document_is_the_same_cached_prefix_for_every_call(tmp_path, fake):
    calls = fake()
    chunks = chunk_set()
    enrich(tmp_path, chunks)
    prefixes = {c["cache_prefix"] for c in calls.calls}
    assert len(prefixes) == 1
    assert chunks.source_text in prefixes.pop()


def test_the_document_sent_is_capped(tmp_path, fake):
    calls = fake()
    chunks = chunk_set(1)
    chunks.source_text = "x" * (DOC_BUDGET + 500)
    _, run_ctx = enrich(tmp_path, chunks)
    assert "x" * DOC_BUDGET in calls.calls[0]["cache_prefix"]
    assert "x" * (DOC_BUDGET + 1) not in calls.calls[0]["cache_prefix"]
    assert "first 40,000 characters" in run_ctx.extras["meta"]["note"]


def test_calls_run_at_once_but_results_stay_in_piece_order(tmp_path, fake):
    # Later pieces answer sooner, so finishing order is the reverse of piece order.
    calls = fake(delay=lambda piece: 0.2 - 0.02 * int(piece[5]))
    out, _ = enrich(tmp_path, chunk_set(8))
    assert calls.most_at_once > 1
    assert [c.embed_text.split(".")[0] for c in out.chunks] == [f"About Piece{i}" for i in range(8)]


def test_usage_is_summed_across_calls(tmp_path, fake):
    fake()
    _, run_ctx = enrich(tmp_path, chunk_set(3))
    usage = run_ctx.extras["meta"]["usage"]
    assert usage["input_tokens"] == 300
    assert usage["output_tokens"] == 21
    assert usage["cache_read_input_tokens"] == 240
    assert usage["model"] == "claude-haiku-4-5"


def test_one_failed_call_fails_the_step_plainly_and_keeps_the_usage(tmp_path, fake):
    fake(fail_on="Piece1")
    run_ctx = ctx(tmp_path)
    with pytest.raises(RuntimeError) as err:
        enrich(tmp_path, chunk_set(3), run_ctx=run_ctx)
    assert str(err.value).startswith("The model call for piece 2 of 3 failed: Rate limited")
    assert "No context was kept" in str(err.value)
    assert run_ctx.extras["meta"]["usage"]["output_tokens"] == 14


def test_a_reply_cut_off_at_max_tokens_fails_the_step(tmp_path, fake, monkeypatch):
    calls = fake()

    def cut_off(model, **kwargs):
        done = calls(model, **kwargs)
        done.stop_reason = "max_tokens" if "Piece1" in kwargs["user"] else done.stop_reason
        return done

    monkeypatch.setattr(llm, "complete", cut_off)
    with pytest.raises(RuntimeError, match="The model call for piece 2 of 3 failed: the reply was cut off"):
        enrich(tmp_path, chunk_set(3))


def test_the_input_chunk_set_is_not_changed(tmp_path, fake):
    fake()
    before = chunk_set()
    enrich(tmp_path, before)
    assert before.chunks[1].embed_text is None
    assert before.chunks[0].embed_text == "Results\n\nPiece0 says something."


def test_the_prompt_asks_for_one_short_sentence():
    from pandion.plugins.enrich.llm_context import SYSTEM_PROMPT

    assert "one sentence of at most about 25 words" in SYSTEM_PROMPT
    assert "page numbers" in SYSTEM_PROMPT and '"this piece"' in SYSTEM_PROMPT


def test_no_key_gives_the_chat_steps_message(tmp_path, fake):
    calls = fake()
    with pytest.raises(ValueError) as err:
        enrich(tmp_path, chunk_set(), run_ctx=ctx(tmp_path, creds=None))
    assert str(err.value) == llm.no_key_message("anthropic")
    assert calls.calls == []


def test_too_many_pieces_is_refused_before_any_call(tmp_path, fake):
    calls = fake()
    with pytest.raises(ValueError) as err:
        enrich(tmp_path, chunk_set(3), max_pieces=2)
    assert str(err.value) == (
        "This document has 3 pieces, and llm_context writes context for at most 2 "
        "(max_pieces). Use bigger pieces, or raise max_pieces."
    )
    assert calls.calls == []


# -- in a pipeline ---------------------------------------------------------------

CONFIG = """\
path: ./index
index:
  parse:
    use: pdfium
  chunk:
    use: recursive_character
    chunk_size: 70
    chunk_overlap: 10
{enrich}  embed:
    use: fake-deterministic
  store:
    use: lancedb
"""

ENRICH = """\
  enrich:
    use: llm_context
    model: claude-haiku-4-5
"""


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return folder


def _pipeline(tmp_path: Path, enrich: str) -> Pipeline:
    file = tmp_path / "pipeline.yaml"
    file.write_text(CONFIG.format(enrich=enrich), encoding="utf-8")
    return Pipeline.from_file(file)


def test_in_a_pipeline_only_the_enrich_result_and_the_index_move(tmp_path, docs, fake):
    calls = fake()
    plain = _pipeline(tmp_path, "").index.run(docs)
    report = _pipeline(tmp_path, ENRICH).index.run(docs, credentials=CREDS)

    assert report.ok
    stages = report.documents["report.pdf"].stages
    assert list(stages) == ["source", "parse", "chunk", "enrich"]
    assert stages["chunk"].status == "cached"
    assert stages["chunk"].artifact_id == plain.documents["report.pdf"].stages["chunk"].artifact_id
    pieces = stages["chunk"].output.chunks
    enriched = stages["enrich"].output.chunks
    assert [(c.id, c.text) for c in enriched] == [(c.id, c.text) for c in pieces]
    assert report.index.artifact_id != plain.index.artifact_id
    assert len(calls.calls) == len(pieces)

    # BM25 reads the text column, which holds what was embedded: the context too.
    rows = lancedb.connect(report.index.output).open_table("chunks").to_arrow().to_pylist()
    assert all(r["text"].startswith("About ") for r in rows)
    assert stages["enrich"].usage["output_tokens"] == 7 * len(pieces)
    assert report.cost()["output_tokens"] == 7 * len(pieces)


def test_a_second_run_reads_the_stored_context(tmp_path, docs, fake):
    calls = fake()
    _pipeline(tmp_path, ENRICH).index.run(docs, credentials=CREDS)
    made = len(calls.calls)
    again = _pipeline(tmp_path, ENRICH).index.run(docs, credentials=CREDS)
    assert again.documents["report.pdf"].stages["enrich"].status == "cached"
    assert len(calls.calls) == made


def test_compare_can_vary_enrich_with_and_without_context(tmp_path, docs, fake):
    import pandion

    fake()
    p = _pipeline(tmp_path, "")
    results = pandion.compare(p, "enrich", ["none", {"use": "llm_context"}], docs, credentials=CREDS)
    without, with_context = list(results)
    assert without.outputs == {}
    assert with_context.outputs["report.pdf"].transform == "llm_context"
    assert with_context.index.index.artifact_id != without.index.index.artifact_id


def test_a_sync_with_credentials_writes_the_contexts(tmp_path, docs, fake):
    calls = fake()
    report = _pipeline(tmp_path, ENRICH).index.sync(docs, credentials=CREDS)
    assert report.ok
    enriched = report.documents["report.pdf"].stages["enrich"].output.chunks
    assert all(c.embed_text.startswith("About ") for c in enriched)
    assert len(calls.calls) == len(enriched)


def test_enrich_round_trips_through_the_file_shape(tmp_path):
    file = tmp_path / "pipeline.yaml"
    file.write_text(CONFIG.format(enrich=ENRICH), encoding="utf-8")
    config = Pipeline.from_file(file).config
    assert config.index.enrich == ("llm_context", {"model": "claude-haiku-4-5"})
    data = to_dict(config)
    assert data["index"]["enrich"] == {"use": "llm_context", "model": "claude-haiku-4-5"}
    assert list(data["index"]) == ["parse", "chunk", "enrich", "embed", "store"]
    assert from_dict(data, base=tmp_path).index.enrich == config.index.enrich


def test_enrich_none_is_left_out(tmp_path):
    data = {
        "path": "./i",
        "index": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character"},
            "enrich": "none",
            "embed": {"use": "fake-deterministic"},
            "store": {"use": "lancedb"},
        },
    }
    config = from_dict(data, base=tmp_path)
    assert config.index.enrich is None
    assert "enrich" not in to_dict(config)["index"]


def test_an_unknown_enrich_step_names_the_choices(tmp_path):
    data = {
        "path": "./i",
        "index": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character"},
            "enrich": {"use": "nope"},
            "embed": {"use": "fake-deterministic"},
            "store": {"use": "lancedb"},
        },
    }
    with pytest.raises(ConfigError, match="llm_context"):
        from_dict(data, base=tmp_path)


def test_pandion_validate_accepts_enrich(tmp_path):
    import subprocess
    import sys

    (tmp_path / "pipeline.yaml").write_text(CONFIG.format(enrich=ENRICH), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-m", "pandion.cli", "validate", "pipeline.yaml"],
        cwd=tmp_path, capture_output=True, text=True, timeout=600, encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    assert "pipeline.yaml is a valid pipeline." in result.stdout


def test_the_anthropic_extra_is_needed(tmp_path):
    from pandion.pipeline import extras_for

    file = tmp_path / "pipeline.yaml"
    file.write_text(CONFIG.format(enrich=ENRICH), encoding="utf-8")
    assert "anthropic" in extras_for(Pipeline.from_file(file).config)
