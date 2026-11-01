"""The `pandion` command: check, run, evaluate and compare a pipeline file.

    pandion validate pipeline.yaml
    pandion strategies [--stage chunk] [--json]
    pandion index pipeline.yaml report.pdf notes/ [--sync] [--through chunk]
    pandion retrieve pipeline.yaml "What is chunking?" [--k 5] [--documents report.pdf]
    pandion ask pipeline.yaml "What is chunking?" [--documents report.pdf]
    pandion eval pipeline.yaml questions.json [--documents report.pdf] [--top-k 5] [--json] [--baseline base.json [--allow 0]]
    pandion compare pipeline.yaml --vary chunk.chunk_size=200,400,800 notes/ [--questions questions.json] [--json]
    pandion install pipeline.yaml [--print]
    pandion init my-project [--index text --query balanced] [--questions questions.json] [--overwrite]
    pandion questions report.pdf --model claude-haiku-4-5 [--count 15] [--out questions.json] [--parser pdfium] [--overwrite]

Every command takes --plugins a,b: modules imported before the file is read,
from the current folder first, so their strategies can be named. Model keys
come from the environment (ANTHROPIC_API_KEY and the others) and are never
printed. The command uses only Pandion's public API, as any app would.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Any

import yaml

import pandion
from pandion import ConfigError, Pipeline
from pandion.extend import PluginError, load_plugins as load_modules, plugin_listing
from pandion.evaluation import COMPARE_STAGES, DEFAULT_TOP_K

#: Pandion's name for each key, and the environment variable it is read from.
ENV_KEYS = {
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "custom_api_key": "OPENAI_COMPATIBLE_API_KEY",
    "openrouter_api_key": "OPENROUTER_API_KEY",
}

#: How much of a piece a hit line shows.
SNIPPET = 160

#: How much of a dropped question `pandion questions` prints.
QUESTION_CHARS = 300


def clean_text(text: str, cap: int | None = None) -> str:
    """`text` safe to print: line breaks and tabs as spaces, other control
    characters taken out, at most `cap` characters. The same cleaning
    `write_questions` gives the text it keeps."""
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", re.sub(r"[\t\n\r\v\f]", " ", text)).strip()
    return text[:cap] if cap is not None else text


def credentials_from_env() -> dict[str, str]:
    """The keys that are set in the environment, under Pandion's names."""
    return {name: os.environ[var] for name, var in ENV_KEYS.items() if os.environ.get(var)}


def load_plugins(names: str | None) -> None:
    """Import each module in `names` (a,b,c), the current folder first."""
    listed = [n.strip() for n in (names or "").split(",") if n.strip()]
    try:
        load_modules(os.getcwd(), listed)
    except PluginError as e:
        if e.module not in listed:
            raise ConfigError(str(e)) from None
        raise ConfigError(f"--plugins names '{e.module}', which cannot be imported: {e.cause}") from None


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
        if args.stage not in catalog:
            raise ValueError(f"--stage names a stage: one of {', '.join(catalog)}; not '{args.stage}'.")
        catalog = {args.stage: catalog[args.stage]}
    if args.json:
        print(json.dumps({stage: sorted(strategies) for stage, strategies in catalog.items()}, indent=2))
        return 0
    for stage, strategies in catalog.items():
        print(stage)
        for name, info in sorted(strategies.items()):
            print(f"  {name}: {info.get('summary', '')}")
    return 0


def cmd_plugins(args: argparse.Namespace) -> int:
    load_plugins(args.plugins)
    rows = plugin_listing()
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    for r in rows:
        print(f"{r['kind']}  {r['name']}  {r['module']}  {r['level']}")
    return 0


def cmd_index(args: argparse.Namespace) -> int:
    p = _load(args)
    # With local files, a whole run is a sync, so the next command remembers
    # which documents to search. --sync also says what changed.
    if args.sync or (args.through is None and _can_sync(p)):
        report = p.index.sync(args.documents, credentials=credentials_from_env())
        _print_index(report)
        if args.sync:
            for word in ("added", "changed", "removed", "unchanged"):
                for document in getattr(report, word):
                    print(f"{word}: {document}")
        for document, reason in report.failed.items():
            print(f"failed: {document}: {reason}")
        return 0 if report.complete else 1
    else:
        report = p.index.run(args.documents, through=args.through, credentials=credentials_from_env())
        _print_index(report)
    return 0 if report.ok else 1


def _documents(args: argparse.Namespace) -> list[str] | None:
    return args.documents or None


def _can_sync(p: Pipeline) -> bool:
    """The documents are local files (the upload source, the default), so sync works."""
    source = p.to_dict()["index"].get("source")
    return source is None or source.get("use") == "upload"


def _no_index(p: Pipeline) -> str:
    """What to do when a search names no documents and nothing remembers an index:
    with local files, pandion index remembers the documents it indexed."""
    if _can_sync(p):
        return (
            "There is no index to search yet. Index the documents first with "
            "pandion index FILE DOC..., or name them with --documents."
        )
    return (
        "There is no index to search yet. Name the documents with --documents: this "
        "pipeline's source cannot sync, so nothing is remembered from one command to the next."
    )


def _searched(fn: Any, p: Pipeline, args: argparse.Namespace) -> Any:
    """Run a search or an answer, saying what to do when there is no index to search."""
    try:
        return fn(args.question, documents=_documents(args), credentials=credentials_from_env())
    except ValueError as exc:
        if args.documents or "no index to search yet" not in str(exc):
            raise
        raise ValueError(_no_index(p)) from None


def cmd_retrieve(args: argparse.Namespace) -> int:
    p = _load(args)
    r = _searched(lambda q, **kw: p.retrieve(q, args.k, **kw), p, args)
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
    a = _searched(p.ask, p, args)
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
        if not raw.strip():
            raise ValueError(f"{VARY_FORM}; '{text}' has an empty value.")
        try:
            value = yaml.safe_load(raw.strip())
        except yaml.YAMLError:
            raise ValueError(f"{VARY_FORM}; '{raw.strip()}' is not a value.") from None
        if listed:
            new = [dict(s) if isinstance(s, dict) else {"use": s} for s in current]
            new[n - 1] = changed(new[n - 1], value)
            variants.append(new)
        else:
            variants.append(changed(current, value))
    return stage, variants


def cost_line(cost: dict[str, Any]) -> str:
    """A report's `cost()` as one line. A part that is unknown is left out, never shown as 0."""
    head = [f"{cost['seconds']:.2f} s"]
    counts = [
        f"{cost[key]:,} {word}"
        for key, word in (("input_tokens", "in"), ("output_tokens", "out"))
        if cost[key] is not None
    ]
    if counts:
        head.append(" / ".join(counts) + " tokens")
    dollars = cost["dollars"]
    if dollars is not None:
        amount = f"about ${dollars:.4f}" if dollars >= 0.0001 or dollars == 0 else "under $0.0001"
        when = "your prices" if cost["prices_as_of"] == "custom" else f"prices as of {cost['prices_as_of']}"
        head.append(f"{amount} (estimate, {when})")
    parts = [", ".join(head)]
    total = cost["steps_run"] + cost["steps_cached"]
    parts.append(f"{cost['steps_cached']} of {total} steps cached")
    if cost["unpriced_models"]:
        parts.append("no price for " + ", ".join(cost["unpriced_models"]))
    if cost.get("uncounted_models"):
        parts.append("no token count for " + ", ".join(cost["uncounted_models"]))
    return "Cost: " + "; ".join(parts)


def cmd_eval(args: argparse.Namespace) -> int:
    if args.allow is not None and args.baseline is None:
        raise ValueError("--allow counts newly missed questions against a baseline: add --baseline base.json.")
    # Read the baseline before anything runs, so a wrong file costs nothing.
    baseline = pandion.evaluation.load_baseline(args.baseline) if args.baseline is not None else None
    p = _load(args)
    report = pandion.evaluate(p, args.questions, args.top_k, documents=_documents(args), credentials=credentials_from_env())
    regression = report.against(baseline) if baseline is not None else None
    if args.json:
        data = {**report.to_dict(), "cost": report.cost()}
        if regression is not None:
            data["regression"] = regression.to_dict()
        print(json.dumps(data, indent=2))
    else:
        print(report)
        print(cost_line(report.cost()))
        if regression is not None:
            print(regression)
    if not all(q.error is None for q in report.questions):
        return 1
    return 0 if regression is None or regression.ok(args.allow or 0) else 1


def cmd_compare(args: argparse.Namespace) -> int:
    p = _load(args)
    stage, variants = parse_vary(args.vary, p.to_dict())
    results = pandion.compare(
        p, stage, variants, args.documents, args.questions,
        top_k=args.top_k, credentials=credentials_from_env(),
    )
    if args.json:
        data = results.to_dict()
        for entry, comparison in zip(data["comparisons"], results):
            entry["cost"] = comparison.cost()
        print(json.dumps(data, indent=2))
    else:
        # Each variant, followed by its cost, then the verdict.
        for comparison in results:
            print(comparison)
            print("  " + cost_line(comparison.cost()))
        whole, variants = str(results), "\n".join(str(c) for c in results)
        verdict = whole[len(variants):].lstrip("\n") if whole.startswith(variants) else ""
        if verdict:
            print(verdict)
    return 0 if all(c.index.ok for c in results) else 1


def cmd_install(args: argparse.Namespace) -> int:
    extras = _load(args).extras()
    package = f"pandion[{','.join(extras)}]" if extras else "pandion"
    if args.print:
        print(f'"{sys.executable}" -m pip install "{package}"')
        return 0
    return subprocess.call([sys.executable, "-m", "pip", "install", package])


def _choose(family: str, given: str | None) -> str:
    """The template named by --index or --query, else the one picked by number at the prompt."""
    if given:
        return given
    templates = pandion.list_templates()[family]
    print(f"Pick the {family} template:")
    for n, t in enumerate(templates, start=1):
        print(f"  {n}. {t['name']} ({t['id']}): {t['summary']}")
    while True:
        try:
            answer = input(f"Type a number from 1 to {len(templates)}: ").strip()
        except EOFError:
            raise ValueError(NO_PROMPT) from None
        if answer.isdigit() and 1 <= int(answer) <= len(templates):
            return templates[int(answer) - 1]["id"]


NO_PROMPT = (
    "pandion init needs --index and --query when it cannot ask you, as here, "
    "where nothing is typed in. For example: pandion init my-project --index text --query balanced"
)


def cmd_init(args: argparse.Namespace) -> int:
    if not (args.index and args.query) and not sys.stdin.isatty():
        raise ValueError(NO_PROMPT)
    try:
        index = _choose("index", args.index)
        query = _choose("query", args.query)
    except KeyboardInterrupt:
        print()
        return 130
    config = pandion.compose_template(index, query)
    written = pandion.new_project(args.folder, config, args.questions, overwrite=args.overwrite)
    print(f"Wrote the project in {args.folder}:")
    for path in written:
        print(f"  {path.relative_to(args.folder).as_posix()}")
    folder = f'"{args.folder}"' if " " in args.folder else args.folder
    print(
        "\nNext steps:\n"
        f"  cd {folder}\n"
        "  python -m venv .venv, then activate it\n"
        "  pip install -r requirements.txt\n"
        "  put your documents in docs/\n"
        "  python run.py\n"
        "README.md says the same, and which key the pipeline needs, if any."
    )
    return 0


def cmd_questions(args: argparse.Namespace) -> int:
    if os.path.exists(args.out) and not args.overwrite:
        raise ValueError(f"{args.out} already exists. Pass --overwrite to replace it, or name another file with --out.")
    load_plugins(args.plugins)
    doc = pandion.parse(args.document, use=args.parser)
    try:
        result = pandion.evaluation.write_questions(
            doc, model=args.model, count=args.count, credentials=credentials_from_env(),
            model_name=args.model_name, base_url=args.base_url,
        )
    except RuntimeError as exc:
        print(f"pandion: {clean_text(str(exc))}", file=sys.stderr)
        return 1
    for line in questions_summary(result, args.count):
        print(line)
    if not result["questions"]:
        print("pandion: No question was kept, so nothing was written.", file=sys.stderr)
        return 1
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote {args.out}.")
    return 0


def questions_summary(result: dict[str, Any], count: int) -> list[str]:
    """What `pandion questions` prints: kept, dropped and why, copied, tokens."""
    kept = result["questions"]
    lines = [f"Kept {len(kept)} of the {count} questions asked for, from {result['parts']} part(s) of the document."]
    if result["parts"] < count:
        lines.append(f"The document has only {result['parts']} paragraph(s), so it was split into fewer parts.")
    lines.append(f"Dropped {len(result['dropped'])}.")
    for drop in result["dropped"]:
        question = clean_text(drop["question"], QUESTION_CHARS) or "(no question)"
        lines.append(f"  {question}: {clean_text(drop['reason'])}")
    copied = sum("copied" in q["tags"] for q in kept)
    lines.append(f"Tagged copied: {copied} (most of their words come from the gold passage).")
    usage = result["usage"]
    counts = [
        f"{usage[key]:,} {word}"
        for key, word in (("input_tokens", "in"), ("output_tokens", "out"))
        if usage[key] is not None
    ]
    tokens = " / ".join(counts) + " tokens" if counts else "tokens not reported"
    lines.append(f"Model: {usage['model']}, {tokens}.")
    return lines


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

    sub = command("plugins", "list the extension points that are loaded", cmd_plugins)
    sub.add_argument("--json", action="store_true", help="print the list as JSON")

    sub = command("index", "index documents with a pipeline file", cmd_index)
    sub.add_argument("config")
    sub.add_argument("documents", nargs="+", help="files or folders to index")
    sub.add_argument("--sync", action="store_true", help="also say which documents were added, changed, removed or unchanged since the last index")
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
    sub.add_argument(
        "--top-k", dest="top_k", type=int, default=DEFAULT_TOP_K, help=f"how many of the top pieces are checked (default {DEFAULT_TOP_K})"
    )
    sub.add_argument("--documents", nargs="+", help="evaluate on exactly these documents, indexing them first if needed")
    sub.add_argument("--json", action="store_true", help="print the report as JSON; save it as a baseline with --json > base.json")
    sub.add_argument("--baseline", help="a report saved with --json: say which questions this run newly missed or newly found")
    sub.add_argument("--allow", type=int, help="with --baseline, how many newly missed questions still exit 0 (default 0)")

    sub = command("compare", "run a pipeline once per value of one setting", cmd_compare)
    sub.add_argument("config")
    sub.add_argument("--vary", required=True, help="stage.setting=a,b,c, such as chunk.chunk_size=200,400,800")
    sub.add_argument("documents", nargs="+", help="files or folders to index")
    sub.add_argument("--questions", help="a question set: evaluate each variant and name the best")
    sub.add_argument(
        "--top-k", dest="top_k", type=int, default=DEFAULT_TOP_K, help=f"how many of the top pieces are checked (default {DEFAULT_TOP_K})"
    )
    sub.add_argument("--json", action="store_true", help="print the comparison as JSON")

    sub = command("install", "install the extras a pipeline file needs", cmd_install)
    sub.add_argument("config")
    sub.add_argument("--print", action="store_true", help="only print the pip command")

    sub = command("init", "start a project folder from an index and a query template", cmd_init)
    sub.add_argument("folder", help="the folder to write the project in")
    sub.add_argument("--index", help="the index template, such as text; asked for when left out")
    sub.add_argument("--query", help="the query template, such as balanced; asked for when left out")
    sub.add_argument("--questions", help="a question set to add, JSON or CSV")
    sub.add_argument("--overwrite", action="store_true", help="write into a folder that already has files in it")

    sub = command("questions", "have a model write a question set from a document", cmd_questions)
    sub.add_argument("document", help="the document, such as report.pdf")
    sub.add_argument("--model", required=True, help="a chat model id, such as claude-haiku-4-5, openrouter or custom")
    sub.add_argument("--count", type=int, default=15, help="how many questions at most (default 15)")
    sub.add_argument("--out", default="questions.json", help="the file to write the set to (default questions.json)")
    sub.add_argument("--model-name", dest="model_name", help="the model id for openrouter or custom")
    sub.add_argument("--base-url", dest="base_url", help="the endpoint for custom, such as http://localhost:11434/v1")
    sub.add_argument("--parser", default="pdfium", help="the parser that reads the document (default pdfium)")
    sub.add_argument("--overwrite", action="store_true", help="replace the --out file when it already exists")
    return root


def _yaml_problem(file: str, exc: yaml.YAMLError) -> str:
    """A YAML error in the pipeline file as one sentence: the file, the line and the problem."""
    mark = getattr(exc, "problem_mark", None)
    where = f" at line {mark.line + 1}" if mark is not None else ""
    problem = getattr(exc, "problem", None) or str(exc).splitlines()[0]
    return f"{file} is not valid YAML{where}: {problem}."


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.fn(args)
    except (ConfigError, OSError, ValueError) as exc:
        print(f"pandion: {exc}", file=sys.stderr)
        return 2
    except yaml.YAMLError as exc:
        print(f"pandion: {_yaml_problem(getattr(args, 'config', 'the file'), exc)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
