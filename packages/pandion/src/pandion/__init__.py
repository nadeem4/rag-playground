"""Pandion: indexing and retrieval pipelines you can inspect stage by stage.

The engine lives in plain modules (`pandion.graph`, `pandion.executor`,
`pandion.storage` and the rest). A name that starts with an underscore is
private; the RAG Playground app may import every other name.

`pandion.parse`, `pandion.clean`, `pandion.chunk` and `pandion.rewrite` run one
stage when called, and hold that stage's step classes. `pandion.retrieve`,
`pandion.rerank` and `pandion.answer` hold the step classes of the rest.
`pandion.evaluation` holds question sets, the miss trace, `evaluate` and
`compare` (also `pandion.evaluate` and `pandion.compare`).
"""

from pandion.models import ModelSettings, preload_embedder, preload_reranker
from pandion.pipeline import (
    Answer,
    IndexPipeline,
    Pipeline,
    QueryPipeline,
    Retrieval,
    RetrievalPipeline,
)
from pandion.evaluation import Comparison, EvaluationReport, QuestionResult, compare, evaluate
from pandion.results import StageResult
from pandion import answer, chunk, clean, evaluation, parse, rerank, retrieve, rewrite

__version__ = "0.1.0"

__all__ = [
    "Answer",
    "Comparison",
    "EvaluationReport",
    "IndexPipeline",
    "ModelSettings",
    "Pipeline",
    "QueryPipeline",
    "QuestionResult",
    "Retrieval",
    "RetrievalPipeline",
    "StageResult",
    "answer",
    "chunk",
    "clean",
    "compare",
    "evaluate",
    "evaluation",
    "parse",
    "preload_embedder",
    "preload_reranker",
    "rerank",
    "retrieve",
    "rewrite",
    "__version__",
]
