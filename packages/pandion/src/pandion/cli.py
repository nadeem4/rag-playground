"""The `pandion` command: check, run, evaluate and compare a pipeline file.

    pandion validate pipeline.yaml
    pandion strategies [--stage chunk] [--json]
    pandion index pipeline.yaml report.pdf notes/ [--sync] [--through chunk]
    pandion retrieve pipeline.yaml "What is chunking?" [--k 5] [--documents report.pdf]
    pandion ask pipeline.yaml "What is chunking?" [--documents report.pdf]
    pandion eval pipeline.yaml questions.json [--documents report.pdf] [--top-k 5] [--json] [--baseline base.json [--allow 0] | --record-baseline base.json] [--judge [--judge-model ID] [--judge-gate]]
    pandion compare pipeline.yaml --vary chunk.chunk_size=200,400,800 notes/ [--questions questions.json] [--json]
    pandion install pipeline.yaml [--print]
    pandion models pull pipeline.yaml [--cache-dir DIR]
    pandion init my-project [--index text --query balanced] [--questions questions.json] [--overwrite]
    pandion trace TRACE_ID --url-env VAR [--json]
    pandion report [--since 7d] [--flagged] --url-env VAR [--json]
    pandion review [--evaluate [--only NAME ...] [--sample 1.0] [--rerun] [--judge [--judge-model ID]]] [--since 7d] --url-env VAR
    pandion review --promote TRACE_ID --questions questions.json [pipeline.yaml] --url-env VAR
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
import time
from pathlib import Path
from typing import Any

import yaml

import pandion
from pandion import ConfigError, Pipeline
from pandion.extend import PluginError, TRACE_LIMIT, format_review_list, format_review_result, parse_sample, promote, relevance_evaluator, run_evaluators, EVALUATORS, TraceStore, format_trace, format_trace_report, parse_since, summarise_traces, get_conversation_store, load_plugins as load_modules, plugin_listing
from pandion.evaluation import COMPARE_STAGES, DEFAULT_TOP_K, JudgeSettings, QuestionSetError, load_questions

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


def sync_line(report: Any, seconds: float) -> str:
    """The one line `pandion sync` prints: JSON, counts only, no document names."""
    cost = report.cost()
    return json.dumps({
        "event": "sync",
        "ok": report.complete,
        "added": len(report.added),
        "changed": len(report.changed),
        "removed": len(report.removed),
        "unchanged": len(report.unchanged),
        "failed": len(report.failed),
        "duration_s": round(seconds, 2),
        "tokens": (cost["input_tokens"] or 0) + (cost["output_tokens"] or 0),
    })


def cmd_sync(args: argparse.Namespace) -> int:
    """Sync the `source:` block. 0 when every document is in, 1 when one was
    left out; a refusal falls to `main`, which exits 2."""
    p = _load(args)
    started = time.monotonic()
    report = p.index.sync_source(credentials=credentials_from_env())
    print(sync_line(report, time.monotonic() - started))
    for document, reason in report.failed.items():
        print(f"failed: {document}: {reason}", file=sys.stderr)
    return 0 if report.complete else 1


def cmd_forget_user(args: argparse.Namespace) -> int:
    """Remove one user's conversations and memories from a conversation store.
    It asks for `--yes` first, since the CLI has no prompts."""
    if not args.yes:
        print(
            f"This would delete every conversation and memory kept for {args.user_id}. "
            "Run it again with --yes to do it.", file=sys.stderr)
        return 1
    if args.store == "sql" and not args.url_env:
        raise ValueError(
            "forget-user with the sql store needs --url-env, the environment variable that holds the database url. "
            "Without it the command would open a new, empty database and delete nothing.")
    store = get_conversation_store(args.store, {"url_env": args.url_env} if args.url_env else {})
    gone = store.delete_user(args.user_id)
    print(f"Deleted {gone['conversations']} conversations and {gone['memories']} memories for {args.user_id}.")
    print("Backups of the database and the retention of your model providers are out of its reach; clear those yourself.")
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    """`models pull`: download the public weights the pipeline needs, one line
    per model. 1 with one sentence when a download fails; no token is printed."""
    try:
        pulled = pandion.pull_models(_load(args), args.cache_dir, lambda model_id, revision: print(f"{model_id} {revision}".rstrip() + " ready"))
    except (RuntimeError, ImportError) as exc:
        print(f"pandion: {exc}", file=sys.stderr)
        return 1
    if not pulled:
        print("This pipeline uses no local model.")
    return 0


def _trace_store(args: argparse.Namespace) -> TraceStore | None:
    """The store the user points at, or None (after saying so) when it keeps no traces."""
    if args.store == "sql" and not args.url_env:
        raise ValueError(
            f"{args.command} with the sql store needs --url-env, the environment variable that holds the database url. "
            "Without it the command would open a new, empty database and show nothing.")
    store = get_conversation_store(args.store, {"url_env": args.url_env} if args.url_env else {})
    if not isinstance(store, TraceStore):
        print(f"The {args.store} store does not keep traces.", file=sys.stderr)
        return None
    return store


def cmd_trace(args: argparse.Namespace) -> int:
    """Print one trace. 1 when the store keeps no traces or has no such trace."""
    store = _trace_store(args)
    if store is None:
        return 1
    record = store.trace(args.trace_id)
    if record is None:
        print(f"There is no trace {args.trace_id} in this store.", file=sys.stderr)
        return 1
    print(json.dumps(record.model_dump(), indent=2) if args.json else format_trace(record))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    """Summarise the stored traces, newest 10,000 at most."""
    store = _trace_store(args)
    if store is None:
        return 1
    since = parse_since(args.since) if args.since else None
    summary = summarise_traces(store.traces(since=since, flagged_only=args.flagged, limit=TRACE_LIMIT))
    if summary.capped:
        print("Only the newest 10,000 traces are counted; narrow with --since.", file=sys.stderr)
    print(json.dumps(summary.model_dump(), indent=2) if args.json else format_trace_report(summary))
    return 0


def cmd_review(args: argparse.Namespace) -> int:
    """List the traces that need a look; with --evaluate, score the stored traces with the online evaluators."""
    load_plugins(args.plugins)
    store = _trace_store(args)
    if store is None:
        return 1
    if args.evaluate and args.promote:
        print("--promote and --evaluate are two different jobs: run them one at a time.", file=sys.stderr)
        return 1
    if (args.judge or args.judge_model) and not args.evaluate:
        print("--judge and --judge-model go with --evaluate, which scores the stored traces.", file=sys.stderr)
        return 1
    if args.promote:
        if not args.questions:
            print("--promote adds a case to a question set: give the file with --questions FILE.", file=sys.stderr)
            return 1
        try:
            p = _load(args) if args.config else None
            print(promote(store, args.promote, args.questions, p=p, credentials=credentials_from_env()))
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 1
        return 0
    since = parse_since(args.since) if args.since else None
    if not args.evaluate:
        traces = store.traces(since=since, limit=TRACE_LIMIT)
        if len(traces) >= TRACE_LIMIT:
            print(f"Only the newest {TRACE_LIMIT:,} traces were read; narrow with --since.", file=sys.stderr)
        print(format_review_list(traces))
        return 0
    try:
        sample = parse_sample(args.sample)
        names, extra = args.only, []
        if args.judge:
            # The built-in relevance judge is never registered; it runs only here.
            if names is None or "relevance" in names:
                judge = JudgeSettings(on=True, **({"model": args.judge_model} if args.judge_model else {}))
                evaluator, tally = relevance_evaluator(judge, credentials_from_env())  # refuses a missing key now
                extra = [evaluator]
            if names is not None:
                names = [n for n in names if n != "relevance"]
        elif args.judge_model or (names and "relevance" in names):
            print("The relevance evaluator calls a model, so it runs only with --judge (and --judge-model goes with it).", file=sys.stderr)
            return 1
        if not names and not extra and not EVALUATORS:
            print("No online evaluators are registered. Write one with @online_evaluator and load it with --plugins.", file=sys.stderr)
            return 1
        result = run_evaluators(store, since=since, names=names, sample=sample, limit=TRACE_LIMIT, rerun=args.rerun, extra=extra)
        if extra:
            result.judge_dollars = tally.dollars
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1
    if result.traces >= TRACE_LIMIT:
        print(f"Only the newest {TRACE_LIMIT:,} traces were read; narrow with --since.", file=sys.stderr)
    out, err = format_review_result(result)
    print(out)
    if err:
        print(err, file=sys.stderr)
    return 0


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
    if args.record_baseline is not None and args.baseline is not None:
        raise ValueError("--record-baseline writes a new baseline and --baseline compares with an old one: use one of them.")
    if (args.judge_model or args.judge_gate) and not args.judge:
        raise ValueError("--judge-model and --judge-gate go with --judge, which turns the correctness judge on.")
    if args.judge_gate and args.baseline is None:
        raise ValueError("--judge-gate compares the mean correctness with a baseline's: add --baseline base.json.")
    judge = JudgeSettings(on=args.judge, gate=args.judge_gate, **({"model": args.judge_model} if args.judge_model else {}))
    # Read the baseline before anything runs, so a wrong file costs nothing.
    baseline = pandion.evaluation.load_baseline(args.baseline) if args.baseline is not None else None
    p = _load(args)
    try:
        asked = load_questions(args.questions)["questions"]
    except QuestionSetError:
        asked = []  # the run below reports a bad set in its own words
    if judge.on and p.query is None:
        raise ValueError("--judge answers each question, so the pipeline file needs an answer: section.")
    env = pandion.evaluation.environment(p, asked)
    # A baseline from another platform or with other models is refused before any search is paid for.
    env_notes = pandion.evaluation.check_environment(baseline, env) if baseline is not None else []
    # An expected passage that is gone fails the run here, before any search is paid for.
    stale = pandion.evaluation.stale_check(p, args.questions, _documents(args), credentials=credentials_from_env())
    if not stale.ok:
        print(json.dumps(stale.to_dict(), indent=2) if args.json else stale, file=None if args.json else sys.stderr)
        return 1
    for warning in stale.warnings:
        print(warning, file=sys.stderr)
    report = pandion.evaluate(
        p, args.questions, args.top_k, documents=_documents(args), credentials=credentials_from_env(), judge=judge
    )
    reasked: list[str] = []
    if baseline is not None:
        # A step that can differ between runs gets one more ask for each newly missed question.
        report, reasked = pandion.evaluation.reask_missed(
            p, report, baseline, args.questions, args.top_k,
            documents=_documents(args), credentials=credentials_from_env(),
        )
    regression = report.against(baseline) if baseline is not None else None
    found_again = {q.id: q.found for q in report.questions if q.id in reasked}
    if regression is not None:
        regression.notes[:0] = env_notes
    if args.json:
        data = {**report.to_dict(), "cost": report.cost(), "environment": env}
        if regression is not None:
            data["regression"] = {**regression.to_dict(), "gate_ok": regression.gate_ok(args.allow or 0, args.judge_gate)}
            data["reasked"] = [{"id": i, "found": found_again[i]} for i in reasked]
        print(json.dumps(data, indent=2))
        if getattr(report, "rewrites_failed", 0):  # stdout stays the report alone
            print(f"{report.rewrites_failed} follow-up question(s) could not be rewritten and were searched as written.", file=sys.stderr)
    else:
        print(report)
        print(cost_line(report.cost()))
        if regression is not None:
            print(regression)
            if reasked:
                again = ", ".join(f"{i} ({'found' if found_again[i] else 'missed again'})" for i in reasked)
                print(f"Asked again because {', '.join(report.nondeterministic)} can differ between runs: {again}.")
            allow = args.allow or 0
            for name in regression.failed_categories(allow):
                print(f'Category "{name}" newly missed: {", ".join(regression.by_category[name]["newly_missed"])}.')
            if args.judge_gate and not regression.judge_ok():
                print(f"Mean correctness fell by more than {pandion.evaluation.JUDGE_DROP} from the baseline's.")
    if not all(q.error is None for q in report.questions):
        return 1
    if args.record_baseline is not None:
        path = Path(args.record_baseline)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({**report.to_dict(), "environment": env}, indent=2), encoding="utf-8")
        # On stderr with --json, so stdout stays the report alone.
        print(
            f"Baseline recorded at {args.record_baseline} (platform {env['platform']}, {len(report.questions)} questions).",
            file=sys.stderr if args.json else sys.stdout,
        )
    return 0 if regression is None or regression.gate_ok(args.allow or 0, args.judge_gate) else 1


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

    sub = command("sync", "sync the source named in the pipeline file", cmd_sync)
    sub.add_argument("config")

    sub = command("forget-user", "delete one user's conversations and memories", cmd_forget_user)
    sub.add_argument("user_id")
    sub.add_argument("--store", default="sql", help="the conversation store, sql by default")
    sub.add_argument("--url-env", help="the environment variable that holds the store's database url")
    sub.add_argument("--yes", action="store_true", help="do it; without this nothing is deleted")

    sub = command("models", "download the public model weights a pipeline needs", cmd_models)
    sub.add_argument("action", choices=["pull"], help="pull: download the weights now, such as at Docker build time")
    sub.add_argument("config")
    sub.add_argument("--cache-dir", help="the folder to download into (default: the file's models.cache_dir, else the Hugging Face default)")

    for name, help, fn in (("trace", "show one stored chat trace", cmd_trace), ("report", "summarise the stored chat traces", cmd_report)):
        sub = command(name, help, fn)
        if name == "trace":
            sub.add_argument("trace_id")
        else:
            sub.add_argument("--since", help="only traces since a duration like 24h or 7d, or an ISO 8601 date")
            sub.add_argument("--flagged", action="store_true", help="only traces that have a flag")
        sub.add_argument("--store", default="sql", help="the conversation store, sql by default")
        sub.add_argument("--url-env", help="the environment variable that holds the store's database url")
        sub.add_argument("--json", action="store_true", help="print JSON")

    sub = command("review", "list the traces that need a look, or score them with the online evaluators", cmd_review)
    sub.add_argument("--evaluate", action="store_true", help="run the online evaluators over the stored traces (never run by the server)")
    sub.add_argument("--only", nargs="+", metavar="NAME", help="only these evaluators; the default is all of them")
    sub.add_argument("--sample", default="1.0", help="the share of traces to score, such as 0.02 or 2%%; the same traces each run")
    sub.add_argument("--rerun", action="store_true", help="score again traces this version of an evaluator already scored")
    sub.add_argument("--judge", action="store_true", help="with --evaluate, also run the relevance judge (one model call per trace with stored passages)")
    sub.add_argument("--judge-model", dest="judge_model", help="the relevance judge's chat model id (default claude-haiku-4-5)")
    sub.add_argument("--promote", metavar="TRACE_ID", help="add this trace to a question set as a case, with --questions FILE")
    sub.add_argument("--questions", help="the JSON question set --promote adds to (created if it is not there)")
    sub.add_argument("config", nargs="?", help="with --promote, a pipeline file: also say whether the miss is in retrieval or in the answer")
    sub.add_argument("--since", help="only traces since a duration like 24h or 7d, or an ISO 8601 date")
    sub.add_argument("--store", default="sql", help="the conversation store, sql by default")
    sub.add_argument("--url-env", help="the environment variable that holds the store's database url")

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
    sub.add_argument("--json", action="store_true", help="print the report as JSON; to save a baseline use --record-baseline")
    sub.add_argument("--baseline", help="a report saved with --record-baseline: say which questions this run newly missed or newly found (each is asked once more first when a step can differ between runs)")
    sub.add_argument("--allow", type=int, help="with --baseline, how many newly missed questions per category still exit 0 (default 0)")
    sub.add_argument("--record-baseline", dest="record_baseline", metavar="PATH", help="write this run as a baseline, with its platform and models, to PATH")
    sub.add_argument("--judge", action="store_true", help="also grade each answer against the question's expected answer with a model (off by default; costs model calls; report only)")
    sub.add_argument("--judge-model", dest="judge_model", help="the judge's chat model (default claude-haiku-4-5)")
    sub.add_argument("--judge-gate", dest="judge_gate", action="store_true", help="with --judge and --baseline, exit 1 when the mean correctness fell more than 0.05 below the baseline's")

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
