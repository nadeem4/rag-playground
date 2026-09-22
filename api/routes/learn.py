"""Learn pages: the Chunking lab and its predict-then-see challenges (I-22).

The challenge settings were chosen by running the real chunkers on the pdfium
parse of `samples/chunking-primer.pdf`, and `tests/api/test_learn.py` re-runs
them to prove every `expect_whole`. Change the sample or a chunker and that
test says which challenge no longer tells the story.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from plugins.chunk import count_tokens

router = APIRouter()

QUESTION = "Why do chunk boundaries matter?"

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
        "parse": {"transform": "pdfium", "config": {}},
        "challenges": CHALLENGES,
    }
