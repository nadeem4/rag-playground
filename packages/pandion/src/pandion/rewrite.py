"""The query steps: call this module to rewrite one question, or use a class in a pipeline.

`pandion.rewrite(question, use="llm_rewrite", style="keywords")` turns one
question into the query retrieval searches with (`pandion.stages.rewrite`).
`LlmRewrite(style="keywords")` is the same settings for a pipeline written in
code (`pandion.config.step_class`). In a pipeline the question is passed to
`p.retrieve` or `p.ask`, never set on the step.
"""

import sys

from pandion.config import step_class
from pandion.ports import Stage
from pandion.stages import StageModule
from pandion.stages import rewrite as run

Text = step_class(Stage.QUERY, "text", __name__)
LlmRewrite = step_class(Stage.QUERY, "llm_rewrite", __name__)

__all__ = ["LlmRewrite", "Text"]

sys.modules[__name__].__class__ = StageModule
