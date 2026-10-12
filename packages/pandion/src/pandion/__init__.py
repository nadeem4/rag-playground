"""Pandion: indexing and retrieval pipelines you can inspect stage by stage.

The engine lives in plain modules (`pandion.graph`, `pandion.executor`,
`pandion.storage` and the rest). A name that starts with an underscore is
private; the RAG Playground app may import every other name.
"""

from pandion.results import StageResult
from pandion.stages import chunk, clean, parse

__version__ = "0.0.1"

__all__ = ["StageResult", "chunk", "clean", "parse", "__version__"]
