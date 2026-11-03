"""Shared builders for the trace tests."""

from types import SimpleNamespace

from pandion.results import StageResult
from pandion.trace_record import TraceRecord


def make_record(**kw) -> TraceRecord:
    fields = {"trace_id": "t1", "user_id": "u1", "conversation_id": "c1", "question": "q", "standalone": "q",
              "answer": "a", "label": "cited", "source_ids": ["s1"], "latency_ms": 120}
    return TraceRecord(**{**fields, **kw})


class StubPipeline:
    """Asks return a fixed answer with two stages and a grounding count."""

    def __init__(self, stats=None, ok=True):
        self.stats, self.ok = stats if stats is not None else {"cited": 1}, ok

    def ask(self, question, **kwargs):
        payload = {"answer": [{"text": "The notice period is 30 days."}], "citations": [{"chunk_id": "c1"}],
                   "stats": self.stats}
        stages = {
            "search": StageResult("search", "hybrid", None, duration_ms=12.0),
            "answer": StageResult("answer", "chat", None, duration_ms=30.0,
                                  usage={"input_tokens": 1000, "output_tokens": 100, "model": "claude-haiku-4-5"}),
        }
        return SimpleNamespace(
            ok=self.ok, text="The notice period is 30 days." if self.ok else "",
            output=SimpleNamespace(payload=payload) if self.ok else None, stages=stages,
            cost=lambda: {"dollars": 0.0021})
