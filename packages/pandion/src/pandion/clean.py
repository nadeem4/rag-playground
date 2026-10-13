"""The cleaners: call this module to clean one document, or use a class in a pipeline.

`pandion.clean(doc, steps=[{"use": "dedupe_blocks"}])` cleans one parsed
document (`pandion.stages.clean`). `DedupeBlocks()` is the same step for a
pipeline written in code (`pandion.config.step_class`).
"""

import sys

from pandion.config import step_class
from pandion.ports import Stage
from pandion.stages import StageModule
from pandion.stages import clean as run

HeaderFooterStrip = step_class(Stage.CLEAN, "header_footer_strip", __name__)
DedupeBlocks = step_class(Stage.CLEAN, "dedupe_blocks", __name__)
DropMatching = step_class(Stage.CLEAN, "drop_matching", __name__)

__all__ = ["DedupeBlocks", "DropMatching", "HeaderFooterStrip"]

sys.modules[__name__].__class__ = StageModule
