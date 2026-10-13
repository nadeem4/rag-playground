"""The rerankers, as classes for a pipeline written in code.

`CrossEncoder(top_k=5)` is the same as the block `{"use": "cross_encoder",
"top_k": 5}` (`pandion.config.step_class`). Reranking runs through a
pipeline: `p.retrieve(question)`.
"""

from pandion.config import step_class
from pandion.ports import Stage

Mmr = step_class(Stage.RERANK, "mmr", __name__)
CrossEncoder = step_class(Stage.RERANK, "cross_encoder", __name__)
LlmRerank = step_class(Stage.RERANK, "llm_rerank", __name__)

__all__ = ["CrossEncoder", "LlmRerank", "Mmr"]
