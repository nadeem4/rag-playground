"""The chunkers: call this module to chunk one document, or use a class in a pipeline.

`pandion.chunk(doc, use="recursive_character", chunk_size=400)` cuts one parsed
document into pieces (`pandion.stages.chunk`). `RecursiveCharacter(chunk_size=400)`
is the same settings for a pipeline written in code (`pandion.config.step_class`).
"""

import sys

from pandion.config import step_class
from pandion.ports import Stage
from pandion.stages import StageModule
from pandion.stages import chunk as run

RecursiveCharacter = step_class(Stage.CHUNK, "recursive_character", __name__)
LayoutBlocks = step_class(Stage.CHUNK, "layout_blocks", __name__)
MarkdownHeader = step_class(Stage.CHUNK, "markdown_header", __name__)
TokenBased = step_class(Stage.CHUNK, "token_based", __name__)
SentenceWindow = step_class(Stage.CHUNK, "sentence_window", __name__)

__all__ = ["LayoutBlocks", "MarkdownHeader", "RecursiveCharacter", "SentenceWindow", "TokenBased"]

sys.modules[__name__].__class__ = StageModule
