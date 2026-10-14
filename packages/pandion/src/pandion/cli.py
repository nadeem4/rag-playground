"""The `pandion` command.

`pandion install pipeline.yaml` reads the file, works out which extras its
steps need, and installs them with pip into the Python that runs it.
`--print` only prints the command. Nothing is ever installed while a pipeline
runs.
"""

from __future__ import annotations

import argparse
import subprocess
import sys

from pandion import Pipeline
from pandion.config import ConfigError, load
# Kept importable from here for older callers; the code lives in pandion.pipeline.
from pandion.pipeline import extras_for  # noqa: F401


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pandion")
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install", help="install the extras a pipeline file needs")
    install.add_argument("config", help="the pipeline file, for example pipeline.yaml")
    install.add_argument("--print", action="store_true", help="only print the pip command")
    args = parser.parse_args(argv)

    try:
        config = load(args.config)
    except (ConfigError, OSError) as exc:
        print(f"pandion: {exc}", file=sys.stderr)
        return 2
    extras = Pipeline._of(config).extras()
    package = f"pandion[{','.join(extras)}]" if extras else "pandion"
    command = [sys.executable, "-m", "pip", "install", package]
    if args.print:
        print(f'"{sys.executable}" -m pip install "{package}"')
        return 0
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
