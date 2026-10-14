"""The pipeline templates (`GET /api/templates`): playground/templates as JSON.

Each family is a list, one entry per template: its id (the file name), the
`template:` block's fields (name, summary, good_for, and a document template's
sample), and `pipeline`, the part of a Pandion pipeline the template sets.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from playground import templates

router = APIRouter()


@router.get("/templates")
def list_templates() -> dict[str, list[dict[str, Any]]]:
    """Both template families, each template with its metadata and pipeline part."""
    return {
        family: [
            {"id": name, **data["template"], "pipeline": {k: v for k, v in data.items() if k != "template"}}
            for name, data in templates.load(family).items()
        ]
        for family in templates.FAMILIES
    }
