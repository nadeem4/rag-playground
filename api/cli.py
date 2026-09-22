"""`rag-playground`: start the server and, on localhost, open the browser.

Host and port come from `--host` / `--port`, else `RAG_PLAYGROUND_HOST` / `PORT`,
else 127.0.0.1:8000. A browser opens only when the host is loopback.
"""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser

import uvicorn

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="rag-playground", description="Run the RAG Playground locally."
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("RAG_PLAYGROUND_HOST", DEFAULT_HOST),
        help="interface to bind (default 127.0.0.1, or $RAG_PLAYGROUND_HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", DEFAULT_PORT)),
        help="port (default 8000, or $PORT)",
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="do not open a browser window"
    )
    parser.add_argument(
        "--reload", action="store_true", help="restart on code changes (development)"
    )
    args = parser.parse_args(argv)

    if not args.no_browser and args.host in LOOPBACK:
        url = f"http://{args.host}:{args.port}/"
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()

    uvicorn.run("api.main:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
