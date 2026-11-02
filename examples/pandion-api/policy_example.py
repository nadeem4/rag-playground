"""Start pandion-api with a Policy that refuses documents over a size limit.

    uv run python examples/pandion-api/policy_example.py --port 8000 --max-mb 5

A Policy holds a site's rules. Subclass it, change only the methods you need,
and pass it to `create_app`.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from fastapi import FastAPI, HTTPException

from pandion_api import ApiSettings, Policy, create_app

DATA = Path(__file__).resolve().parent / "pandion-data"


class SizeLimitedPolicy(Policy):
    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes

    def check_document(self, data: bytes, filename: str, request) -> None:
        if len(data) > self.max_bytes:
            raise HTTPException(status_code=413, detail=f"{filename} is over the limit of {self.max_bytes} bytes.")


def make_app(data_dir: Path = DATA, max_bytes: int = 5 * 1024 * 1024) -> FastAPI:
    return create_app(ApiSettings(data_dir=data_dir, prefix="/api/v2"), policy=SizeLimitedPolicy(max_bytes))


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-mb", type=int, default=5)
    args = parser.parse_args()
    uvicorn.run(make_app(max_bytes=args.max_mb * 1024 * 1024), host="127.0.0.1", port=args.port)
