"""Serve the built SPA from `web/dist`, with a fallback for client routes.

Registered after the API routers, so `/api/*` always wins. An unknown `/api`
path is a JSON 404, never the SPA. When there is no build yet, every page is a
short instruction to build the frontend instead of a bare 404.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

NOT_BUILT = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>RAG Playground</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>RAG Playground</h1>
<p>The API is running, but the web UI has not been built yet.</p>
<p>Build it once, then reload this page:</p>
<pre>cd web
npm install
npm run build</pre>
<p>The API itself is under <a href="/api/registry">/api</a>.</p>
</body>
</html>
"""


def mount_spa(app: FastAPI, dist: Path) -> None:
    dist = Path(dist)

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        index = dist / "index.html"
        if not index.is_file():
            return HTMLResponse(NOT_BUILT)
        root = dist.resolve()
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index)
