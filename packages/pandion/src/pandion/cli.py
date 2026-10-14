"""The `pandion` command: check, run, evaluate and compare a pipeline file.

    pandion validate pipeline.yaml
    pandion strategies [--stage chunk] [--json]
    pandion index pipeline.yaml report.pdf notes/ [--sync] [--through chunk]
    pandion retrieve pipeline.yaml "What is chunking?" [--k 5] [--documents report.pdf]
    pandion ask pipeline.yaml "What is chunking?" [--documents report.pdf]
    pandion eval pipeline.yaml questions.json [--documents report.pdf] [--top-k 5] [--json]
    pandion compare pipeline.yaml --vary chunk.chunk_size=200,400,800 notes/ [--questions questions.json] [--json]
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

import yaml

import pandion
from pandion import ConfigError, Pipeline
from pandion.evaluation import COMPARE_STAGES, QuestionSetError

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


VARY_FORM = "--vary takes stage.setting=a,b,c, such as chunk.chunk_size=200,400,800 or clean.2.min_chars=20,40"


def parse_vary(text: str, config: dict[str, Any]) -> tuple[str, list[Any]]:
    """`stage.setting=a,b,c` as (stage, variants): the stage's block with that one setting changed, once per value.
    `stage.use=a,b` varies the strategy itself. Clean and rerank are lists: name the step, `clean.2.min_chars=...`."""
    key, sep, values = text.partition("=")
    parts = key.split(".")
    if not sep or not values or len(parts) not in (2, 3):
        raise ValueError(f"{VARY_FORM}; not '{text}'.")
    stage, setting = parts[0], parts[-1]
    section = COMPARE_STAGES.get(stage)
    if section is None:
        raise ValueError(f"--vary names a stage compare can vary: one of {', '.join(COMPARE_STAGES)}; not '{stage}'.")
    current = (config.get(section) or {}).get(stage)
    listed = stage in ("clean", "rerank")
    if listed:
        steps = list(current or [])
        if len(parts) != 3 or not parts[1].isdigit():
            raise ValueError(f"{stage} is a list of steps: name one, such as {stage}.1.{setting}=...")
        n = int(parts[1])
        if not 1 <= n <= len(steps):
            raise ValueError(f"The pipeline has {len(steps)} {stage} step(s); {stage}.{n} is not one of them.")
    elif len(parts) != 2:
        raise ValueError(f"{VARY_FORM}; not '{text}'.")
    elif current is None:
        raise ValueError(f"The pipeline has no {section}.{stage} step to vary.")

    def changed(block: Any, value: Any) -> dict[str, Any]:
        base = dict(block) if isinstance(block, dict) else {"use": block}
        return {"use": value} if setting == "use" else {**base, setting: value}

    variants: list[Any] = []
    for raw in values.split(","):
        value = yaml.safe_load(raw.strip())
        if listed:
            new = [dict(s) if isinstance(s, dict) else {"use": s} for s in current]
            new[n - 1] = changed(new[n - 1], value)
            variants.append(new)
        else:
            variants.append(changed(current, value))
    return stage, variants


def cmd_eval(args: argparse.Namespace) -> int:
    p = _load(args)
    try:
        report = pandion.evaluate(p, args.questions, args.top_k, documents=_documents(args), credentials=credentials_from_env())
    except QuestionSetError as exc:
        raise ValueError(str(exc)) from None
    print(json.dumps(report.to_dict(), indent=2) if args.json else report)
    return 0 if all(q.error is None for q in report.questions) else 1


def cmd_compare(args: argparse.Namespace) -> int:
    p = _load(args)
    stage, variants = parse_vary(args.vary, p.to_dict())
    try:
        results = pandion.compare(
            p, stage, variants, args.documents, args.questions,
            top_k=args.top_k, credentials=credentials_from_env(),
        )
    except QuestionSetError as exc:
        raise ValueError(str(exc)) from None
    print(json.dumps(results.to_dict(), indent=2) if args.json else results)
    return 0 if all(c.index.ok for c in results) else 1


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

    sub = command("eval", "evaluate a pipeline on a question set", cmd_eval)
    sub.add_argument("config")
    sub.add_argument("questions", help="a question set, JSON or CSV, in the samples' format")
    sub.add_argument("--top-k", dest="top_k", type=int, default=5, help="how many of the top pieces are checked (default 5)")
    sub.add_argument("--documents", nargs="+", help="evaluate on exactly these documents, indexing them first if needed")
    sub.add_argument("--json", action="store_true", help="print the report as JSON")

    sub = command("compare", "run a pipeline once per value of one setting", cmd_compare)
    sub.add_argument("config")
    sub.add_argument("--vary", required=True, help="stage.setting=a,b,c, such as chunk.chunk_size=200,400,800")
    sub.add_argument("documents", nargs="+", help="files or folders to index")
    sub.add_argument("--questions", help="a question set: evaluate each variant and name the best")
    sub.add_argument("--top-k", dest="top_k", type=int, default=5)
    sub.add_argument("--json", action="store_true", help="print the comparison as JSON")

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
