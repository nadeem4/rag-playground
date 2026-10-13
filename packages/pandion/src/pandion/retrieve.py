"""The retrievers, as classes for a pipeline written in code.

`HybridRrf(top_k=20)` is the same as the block `{"use": "hybrid_rrf",
"top_k": 20}` (`pandion.config.step_class`). Searching runs through a
pipeline: `p.retrieve(question)`.
"""

from pandion.config import step_class
from pandion.ports import Stage

Dense = step_class(Stage.RETRIEVE, "dense", __name__)
Bm25 = step_class(Stage.RETRIEVE, "bm25", __name__)
HybridRrf = step_class(Stage.RETRIEVE, "hybrid_rrf", __name__)

__all__ = ["Bm25", "Dense", "HybridRrf"]
