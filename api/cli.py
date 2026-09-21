"""`rag-playground`: start the server on localhost and open the browser."""

from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

HOST = "127.0.0.1"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="rag-playground", description="Run the RAG Playground locally."
    )
    parser.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    parser.add_argument(
        "--no-browser", action="store_true", help="do not open a browser window"
    )
    parser.add_argument(
        "--reload", action="store_true", help="restart on code changes (development)"
    )
    args = parser.parse_args(argv)

    if not args.no_browser:
        url = f"http://{HOST}:{args.port}/"
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()

    uvicorn.run("api.main:app", host=HOST, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
