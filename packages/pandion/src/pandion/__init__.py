"""Pandion: indexing and retrieval pipelines you can inspect stage by stage.

The public API is what this module exports, the stage namespaces
(`pandion.parse` to `pandion.answer`), `pandion.evaluation` and
`pandion.extend`, each with its own `__all__`. Every other module
(`pandion.graph`, `pandion.executor`, `pandion.storage` and the rest) is
internal and may change without notice.

`pandion.parse`, `pandion.clean`, `pandion.chunk` and `pandion.rewrite` run one
stage when called, and hold that stage's step classes. `pandion.retrieve`,
`pandion.rerank` and `pandion.answer` hold the step classes of the rest.
`pandion.evaluation` holds question sets, the miss trace, `evaluate` and
`compare` (also `pandion.evaluate` and `pandion.compare`).
"""

from pandion.models import ModelSettings, preload_embedder, preload_reranker
from pandion.config import ConfigError
from pandion.pipeline import (
    Answer,
    IndexPipeline,
    Pipeline,
    QueryPipeline,
    Retrieval,
    RetrievalPipeline,
)
from pandion.evaluation import (
    Comparison,
    Comparisons,
    EvaluationReport,
    QuestionResult,
    compare,
    evaluate,
)
from pandion.results import ResultStore, StageResult
from pandion.strategy_catalog import catalog, defaults, explain
from pandion import answer, chunk, clean, evaluation, parse, rerank, retrieve, rewrite

__version__ = "0.1.0"

__all__ = [
    "Answer",
    "Comparison",
    "Comparisons",
    "ConfigError",
    "EvaluationReport",
    "IndexPipeline",
    "ModelSettings",
    "Pipeline",
    "QueryPipeline",
    "QuestionResult",
    "Retrieval",
    "RetrievalPipeline",
    "ResultStore",
    "StageResult",
    "answer",
    "catalog",
    "chunk",
    "clean",
    "compare",
    "defaults",
    "evaluate",
    "evaluation",
    "explain",
    "parse",
    "preload_embedder",
    "preload_reranker",
    "rerank",
    "retrieve",
    "rewrite",
    "__version__",
]
