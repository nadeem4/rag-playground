"""The `pandion` command: check, run, evaluate and compare a pipeline file.

    pandion validate pipeline.yaml
    pandion strategies [--stage chunk] [--json]
    pandion index pipeline.yaml report.pdf notes/ [--sync] [--through chunk]
    pandion retrieve pipeline.yaml "What is chunking?" [--k 5] [--documents report.pdf]
    pandion ask pipeline.yaml "What is chunking?" [--documents report.pdf]
    pandion install pipeline.yaml [--print]

Every command takes --plugins a,b: modules imported before the file is read,
from the current folder first, so their strategies can be named. Model keys
come from the environment (ANTHROPIC_API_KEY and the others) and are never
printed. The command uses only Pandion's public API, as any app would.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import subprocess
import sys
from typing import Any

import pandion
from pandion import ConfigError, Pipeline

#: Pandion's name for each key, and the environment variable it is read from.
ENV_KEYS = {
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "custom_api_key": "OPENAI_COMPATIBLE_API_KEY",
    "openrouter_api_key": "OPENROUTER_API_KEY",
}

#: How much of a piece a hit line shows.
SNIPPET = 160


def credentials_from_env() -> dict[str, str]:
    """The keys that are set in the environment, under Pandion's names."""
    return {name: os.environ[var] for name, var in ENV_KEYS.items() if os.environ.get(var)}


def load_plugins(names: str | None) -> None:
    """Import each module in `names` (a,b,c), the current folder first."""
    if not names:
        return
    if os.getcwd() not in sys.path:
        sys.path.insert(0, os.getcwd())
    for name in (n.strip() for n in names.split(",")):
        if not name:
            continue
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - any import error is the user's to see
            raise ConfigError(f"--plugins names '{name}', which cannot be imported: {exc}") from None


def _load(args: argparse.Namespace) -> Pipeline:
    load_plugins(args.plugins)
    return Pipeline.from_yaml(args.config)


def _ms(value: float | None) -> str:
    return "" if value is None else f"{value:.0f} ms"


def _last_line(error: str) -> str:
    lines = error.strip().splitlines()
    return lines[-1] if lines else error


def _step_line(document: str, name: str, step: Any) -> str:
    line = f"{document}  {name}  {step.status}  {_ms(step.duration_ms)}".rstrip()
    if step.error:
        line += f"\n    {_last_line(step.error)}"
    return line


def _print_index(report: Any) -> None:
    for document, doc in report.documents.items():
        for name, step in doc.stages.items():
            print(_step_line(document, name, step))
    if report.index is not None:
        print(_step_line("index", report.index.transform, report.index))


def _first_error(stages: dict[str, Any]) -> str | None:
    """The first error among the steps; "rerank" holds a list of them."""
    for value in stages.values():
        for step in value if isinstance(value, list) else [value]:
            if getattr(step, "error", None):
                return _last_line(step.error)
    return None


def cmd_validate(args: argparse.Namespace) -> int:
    _load(args)
    print(f"{args.config} is a valid pipeline.")
    return 0


def cmd_strategies(args: argparse.Namespace) -> int:
    load_plugins(args.plugins)
    catalog = pandion.catalog()
    if args.stage:
        catalog = {args.stage: catalog.get(args.stage, {})}
    if args.json:
        print(json.dumps({stage: sorted(strategies) for stage, strategies in catalog.items()}, indent=2))
        return 0
    for stage, strategies in catalog.items():
        print(stage)
        for name, info in sorted(strategies.items()):
            print(f"  {name}: {info.get('summary', '')}")
    return 0


def cmd_index(args: argparse.Namespace) -> int:
    p = _load(args)
    if args.sync:
        report = p.index.sync(args.documents)
        _print_index(report)
        for word in ("added", "changed", "removed", "unchanged"):
            for document in getattr(report, word):
                print(f"{word}: {document}")
    else:
        report = p.index.run(args.documents, through=args.through, credentials=credentials_from_env())
        _print_index(report)
    return 0 if report.ok else 1


def _documents(args: argparse.Namespace) -> list[str] | None:
    return args.documents or None


#: Said when a search names no documents and no sync has run: only a sync is
#: remembered from one command to the next.
NO_INDEX = (
    "From the command line, name the documents with --documents, or index them "
    "with pandion index FILE DOC... --sync first: a sync is remembered, a plain index run is not."
)


def _searched(fn: Any, args: argparse.Namespace) -> Any:
    """Run a search or an answer, adding NO_INDEX when there is no index to search."""
    try:
        return fn(args.question, documents=_documents(args), credentials=credentials_from_env())
    except ValueError as exc:
        if args.documents or "no index to search yet" not in str(exc):
            raise
        raise ValueError(f"{exc} {NO_INDEX}") from None


def cmd_retrieve(args: argparse.Namespace) -> int:
    p = _load(args)
    r = _searched(lambda q, **kw: p.retrieve(q, args.k, **kw), args)
    if not r.ok:
        error = _first_error({"index": r.index, **r.stages}) or "a step was skipped"
        print(f"pandion: the search failed: {error}", file=sys.stderr)
        return 1
    for hit in r.hits:
        text = " ".join(hit.chunk.text.split())
        print(f"{hit.rank}. {hit.score:.4f}  {text[:SNIPPET]}")
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    p = _load(args)
    a = _searched(p.ask, args)
    if not a.ok:
        error = _first_error({"index": a.index, **a.stages}) or "a step before the answer failed"
        print(f"pandion: no answer: {error}", file=sys.stderr)
        return 1
    print(a.text)
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    extras = _load(args).extras()
    package = f"pandion[{','.join(extras)}]" if extras else "pandion"
    if args.print:
        print(f'"{sys.executable}" -m pip install "{package}"')
        return 0
    return subprocess.call([sys.executable, "-m", "pip", "install", package])


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="pandion", description="Check, run, evaluate and compare a Pandion pipeline file.")
    commands = root.add_subparsers(dest="command", required=True)

    def command(name: str, help: str, fn) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help)
        sub.add_argument("--plugins", help="modules to import first, comma separated, such as my_steps,their_steps")
        sub.set_defaults(fn=fn)
        return sub

    sub = command("validate", "check a pipeline file", cmd_validate)
    sub.add_argument("config", help="the pipeline file, such as pipeline.yaml")

    sub = command("strategies", "list every strategy by stage", cmd_strategies)
    sub.add_argument("--stage", help="only this stage, such as chunk")
    sub.add_argument("--json", action="store_true", help="print the names as JSON")

    sub = command("index", "index documents with a pipeline file", cmd_index)
    sub.add_argument("config")
    sub.add_argument("documents", nargs="+", help="files or folders to index")
    sub.add_argument("--sync", action="store_true", help="index what changed since the last sync, and drop what is gone")
    sub.add_argument("--through", help="stop after this step: parse, clean, clean.2, chunk or index")

    for name, help, fn in (("retrieve", "search the index for a question", cmd_retrieve), ("ask", "answer a question", cmd_ask)):
        sub = command(name, help, fn)
        sub.add_argument("config")
        sub.add_argument("question")
        sub.add_argument("--documents", nargs="+", help="search exactly these documents, indexing them first if needed")
        if name == "retrieve":
            sub.add_argument("--k", type=int, help="how many pieces to show")

    sub = command("install", "install the extras a pipeline file needs", cmd_install)
    sub.add_argument("config")
    sub.add_argument("--print", action="store_true", help="only print the pip command")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.fn(args)
    except (ConfigError, OSError, ValueError) as exc:
        print(f"pandion: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
