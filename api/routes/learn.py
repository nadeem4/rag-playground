"""Learn pages: the Chunking lab and its predict-then-see challenges (I-22).

The challenge settings were chosen by running the real chunkers on the pdfium
parse of `samples/chunking-primer.pdf`, and `tests/api/test_learn.py` re-runs
them to prove every `expect_whole`. Change the sample or a chunker and that
test says which challenge no longer tells the story.
"""

from __future__ import annotations

from functools import cache
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from fastapi import APIRouter

from api import demo
from core.ports import RunContext, Stage
from core.registry import registry
from plugins.chunk import DocView, count_tokens

router = APIRouter()

QUESTION = "Why do chunk boundaries matter?"

PARSE: dict[str, Any] = {"transform": "pdfium", "config": {}}

#: Copied from the pdfium parse of the sample, not typed from memory.
ANSWER_SENTENCE = (
    "When a boundary falls in the middle of an explanation, the question lands on "
    "one half and the answer on the other, and neither half scores well on its own."
)

CHALLENGES: list[dict[str, Any]] = [
    {
        "id": "shrink",
        "title": "Shrink the chunks",
        "strategy": "recursive_character",
        "config": {"chunk_size": 120, "chunk_overlap": 0},
        "expect_whole": False,
    },
    {
        "id": "room",
        "title": "Give it room",
        "strategy": "recursive_character",
        "config": {"chunk_size": 300, "chunk_overlap": 0},
        "expect_whole": True,
    },
    {
        "id": "naive",
        "title": "The naive way",
        "strategy": "token_based",
        "config": {"max_tokens": 100, "overlap": 0},
        "expect_whole": False,
    },
    {
        "id": "overlap",
        "title": "Overlap to the rescue",
        "strategy": "token_based",
        "config": {"max_tokens": 100, "overlap": 35},
        "expect_whole": True,
    },
]


@router.get("/learn/chunking")
def get_chunking_lesson() -> dict[str, Any]:
    return {
        "question": QUESTION,
        "answer_sentence": ANSWER_SENTENCE,
        # Counted the way each chunker counts: recursive_character in
        # characters, token_based with the shared token counter.
        "sentence_chars": len(ANSWER_SENTENCE),
        "sentence_tokens": count_tokens(ANSWER_SENTENCE),
        "parse": PARSE,
        "challenges": CHALLENGES,
    }


@cache
def _parsed_sample() -> tuple[str, int]:
    """The sample parsed the way the lessons parse it.

    The text is the projection the chunkers cut, so the Text view in a lesson
    shows exactly what the steps work on. Parsed once per process.
    """
    cls = registry.get(Stage.PARSE, PARSE["transform"])
    sample = demo.SAMPLE_PDF
    with TemporaryDirectory() as tmp:
        ctx = RunContext(output_dir=Path(tmp), emit=lambda event: None, tmp=Path(tmp))
        doc = cls().apply(
            {"file": {"path": str(sample), "sha": "sample", "filename": sample.name}},
            cls.config_model(**PARSE["config"]),
            ctx,
        )
    view = DocView.of(doc)
    return view.text, view.doc.page_count


@router.get("/learn/document")
def get_lesson_document() -> dict[str, Any]:
    """The sample document every lesson works on, as parsed text."""
    text, page_count = _parsed_sample()
    return {
        "filename": demo.SAMPLE_PDF.name,
        "page_count": page_count,
        "text": text,
    }
