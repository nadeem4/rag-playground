"""The pipeline templates (`GET /api/templates`), as Pandion lists them.

Each family is a list, one entry per template: its id, name, summary and
good_for, an index template's optional sample, a query template's needs_key, and
`pipeline`, the part of a Pandion pipeline the template sets. `shared` holds the
embed and store every index template uses. See `pandion.list_templates`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

import pandion

router = APIRouter()


@router.get("/templates")
def list_templates() -> dict[str, Any]:
    """Both template families and the shared index, each template with its metadata and pipeline part."""
    return pandion.list_templates()
