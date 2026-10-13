"""Small helpers for the app's tests that call a reranker or read an index.

The rerankers and their own tests moved into pandion (`packages/pandion/tests/
test_rerank*.py`). The app's demo, OpenRouter and chat tests still use a few of
their helpers, so they keep these copies: a candidate list, a run context with
keys, a fake chat model, and an index folder with only its descriptor.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pandion import llm
from pandion.llm import Completion
from pandion.payloads import Chunk, Hit, RetrievalResult
from pandion.plugins.index.lancedb_store import DESCRIPTOR
from pandion.ports import RunContext

QUESTION = "What is the capital of France?"
CREDS = {
    "anthropic_api_key": "sk-ant-test",
    "openai_api_key": "sk-openai-test",
}


class FakeComplete:
    def __init__(self, reply: str, stop_reason: str = "end_turn"):
        self.reply = reply
        self.stop_reason = stop_reason
        self.calls: list[dict] = []

    def __call__(self, model, **kwargs):
        self.calls.append({"model": model, **kwargs})
        return Completion(
            text=self.reply,
            usage={"input_tokens": 1, "output_tokens": 1},
            stop_reason=self.stop_reason,
        )


@pytest.fixture
def reply(monkeypatch):
    """Install a fake `complete` that answers with the given text."""

    def install(text: str, stop_reason: str = "end_turn") -> FakeComplete:
        fake = FakeComplete(text, stop_reason)
        monkeypatch.setattr(llm, "complete", fake)
        return fake

    return install


def payload(texts: list[str]) -> dict:
    hits = [
        Hit(
            chunk=Chunk(
                id=f"chunk-{i}",
                text=text,
                doc_id="doc-1",
                ordinal=i,
                source_element_ids=[f"el-{i}"],
                page_span=(1, 1),
            ),
            score=1.0 - i / 10,
            rank=i + 1,
            retriever="hybrid_rrf",
        )
        for i, text in enumerate(texts)
    ]
    return RetrievalResult(
        hits=hits, query_id="q" * 16, fetch_k=len(hits), total_candidates=len(hits)
    ).model_dump(mode="json")


def ctx(tmp_path, creds: dict | None = CREDS) -> RunContext:
    run_ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    if creds is not None:
        run_ctx.extras["credentials"] = dict(creds)
    return run_ctx


def write_index(directory: Path, **descriptor) -> Path:
    """An index directory as far as the chat and MMR steps read one: its
    `descriptor.json`, naming the embedder and the width."""
    directory.mkdir(parents=True, exist_ok=True)
    desc = {
        "backends": ["dense", "fts"],
        "native_dim": 384,
        "dim": 384,
        "metric": "cosine",
        "embedding_model": "fake-deterministic",
        "embedding_revision": "1",
        "vector_kind": "dense",
        "doc_count": 0,
        "embeddings_computed": 0,
        "embeddings_cached": 0,
    } | descriptor
    (directory / DESCRIPTOR).write_text(json.dumps(desc), encoding="utf-8")
    return directory
