"""Start pandion-api on its own, with the default Policy, which allows everything.

    uv run python examples/pandion-api/serve.py --port 8000

The routes are under /api/v2, and every file the server keeps goes in
pandion-data/ next to this script.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from fastapi import FastAPI

from pandion_api import ApiSettings, create_app

DATA = Path(__file__).resolve().parent / "pandion-data"


def make_app(data_dir: Path = DATA) -> FastAPI:
    return create_app(ApiSettings(data_dir=data_dir, prefix="/api/v2"))


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(make_app(), host="127.0.0.1", port=args.port)
