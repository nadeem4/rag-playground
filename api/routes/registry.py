from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/registry")
def get_registry(request: Request) -> dict[str, Any]:
    return request.app.state.deps.registry.export_schema()
