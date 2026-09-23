"""The committed sample question set (I-25).

The questions live in `samples/questions.json` next to the sample PDF, so they
are reviewed and versioned like the document they are about. Each gold answer is
a sentence copied word for word out of that document, and
`tests/api/test_samples.py` checks every one of them against the real parse, so
the set cannot quietly rot when the sample changes.

Read once per process: the file is committed, and a running server never sees it
change.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter()

QUESTIONS_FILE = Path(__file__).resolve().parents[2] / "samples" / "questions.json"


@cache
def _questions() -> list[dict[str, Any]]:
    return json.loads(QUESTIONS_FILE.read_text(encoding="utf-8"))


@router.get("/samples/questions")
def get_sample_questions() -> list[dict[str, Any]]:
    """The evaluation question set for the bundled sample document."""
    return _questions()
