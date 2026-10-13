"""The parsers: call this module to parse one file, or use a class in a pipeline.

`pandion.parse("a.pdf", use="docling", do_ocr=False)` parses one file
(`pandion.stages.parse`). `Docling(do_ocr=False)` is the same settings for a
pipeline written in code (`pandion.config.step_class`).
"""

import sys

from pandion.config import step_class
from pandion.ports import Stage
from pandion.stages import StageModule
from pandion.stages import parse as run

Pdfium = step_class(Stage.PARSE, "pdfium", __name__)
Docling = step_class(Stage.PARSE, "docling", __name__)

__all__ = ["Docling", "Pdfium"]

sys.modules[__name__].__class__ = StageModule
