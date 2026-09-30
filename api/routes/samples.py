"""The bundled sample set (I-25).

Each sample lives in `samples/<name>/`, with a card (`sample.json`), the PDF and
a question set next to it, so they are reviewed and versioned like the document
they are about. Each gold answer is a sentence copied word for word out of that
document, and `tests/api/test_samples.py` checks every one of them against the
real parse, so the set cannot quietly rot when a sample changes.

Read once per process via `api.sample_set`: the folders are committed, and a
running server never sees them change.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from api import sample_set

router = APIRouter()


@router.get("/samples")
def list_samples() -> list[dict[str, Any]]:
    """Every bundled sample's card, the default first."""
    return [s.card() for s in sample_set.all_samples()]


@router.get("/samples/questions")
def get_default_sample_questions() -> list[dict[str, Any]]:
    """The default sample's question set. Kept for older clients."""
    return sample_set.default_sample().questions()


@router.get("/samples/{name}/questions")
def get_sample_questions(name: str) -> list[dict[str, Any]]:
    """The evaluation question set for one bundled sample, by name."""
    try:
        return sample_set.get_sample(name).questions()
    except KeyError:
        raise HTTPException(404, f"no sample named '{name}'") from None
