"""Online evaluators: checks of stored chat traces, run in a batch.

Provisional. `@online_evaluator` registers a function of one `TraceRecord`
that returns a number, a string or a boolean for each output it declared.
`run_evaluators` (the engine of `pandion review --evaluate`) runs them over
stored traces and saves the results on each trace under
`"<name>@<version>.<output>"`, so a new version scores again beside the old one.

An evaluator sees only the stored trace; it never searches again. It runs only
in a batch, never inside a server. One that raises is counted as a failure by
its exception type (never its message, which may hold user text) and never
stops the batch.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from pandion.conversation_store import TraceStore
from pandion.trace_record import TraceRecord

#: The output types an evaluator may declare, and the Python type each one checks.
OUTPUT_TYPES: dict[str, type] = {"float": float, "str": str, "bool": bool}


@dataclass(frozen=True)
class OnlineEvaluator:
    name: str
    version: str
    outputs: dict[str, str]
    fn: Callable[[TraceRecord], dict[str, float | str | bool]]

    @property
    def label(self) -> str:
        return f"{self.name}@{self.version}"

    def key(self, output: str) -> str:
        return f"{self.label}.{output}"


EVALUATORS: dict[str, OnlineEvaluator] = {}


def online_evaluator(name: str, *, version: str, outputs: dict[str, str]) -> Callable:
    """Register `fn(trace) -> {output: value}` as the evaluator `name`.

    `outputs` maps each output name to `"float"`, `"str"` or `"bool"`; `fn` must
    return exactly those keys. Only the float outputs average in `pandion report`.
    """
    bad = sorted({t for t in outputs.values() if t not in OUTPUT_TYPES})
    if bad:
        raise ValueError(f"The output type of an online evaluator is float, str or bool, not '{bad[0]}'.")

    def add(fn: Callable) -> Callable:
        if name in EVALUATORS:
            old = EVALUATORS[name].fn
            raise ValueError(
                f"'{name}' is already an online evaluator, registered by {old.__module__}.{old.__name__}. "
                f"Rename the one in {fn.__module__}."
            )
        EVALUATORS[name] = OnlineEvaluator(name, version, dict(outputs), fn)
        return fn

    return add


class SkipTrace(Exception):
    """Raised by an evaluator that has nothing to score on this trace: counted as skipped, not failed."""


class JudgeFailed(Exception):
    """The relevance judge gave no usable score. Counted as a failure by this type."""


def relevance_evaluator(settings: Any, credentials: dict[str, Any] | None = None) -> OnlineEvaluator:
    """The built-in `relevance` evaluator: a model judges the stored answer against the stored passages.

    It is not registered; `pandion review --evaluate --judge` hands it to `run_evaluators`
    as `extra`. A trace with no stored passages is skipped. It never searches again.
    """
    from pandion.judge import judge_relevance

    def relevance(trace: TraceRecord) -> dict[str, float]:
        if not trace.sources:
            raise SkipTrace
        verdict = judge_relevance(trace.standalone or trace.question, trace.answer, [s.text for s in trace.sources], settings, credentials)
        if verdict is None:
            raise JudgeFailed
        return {"score": verdict.score}

    return OnlineEvaluator("relevance", "1", {"score": "float"}, relevance)


class ReviewResult(BaseModel):
    #: Traces read from the store.
    traces: int = 0
    #: Evaluator runs that saved scores, and runs left out because the version had scored the trace.
    scored: int = 0
    skipped: int = 0
    #: Runs saved, by "name@version".
    by_evaluator: dict[str, int] = {}
    #: Failures by "name@version", then by exception type. Never a message.
    failures: dict[str, dict[str, int]] = {}


def _chosen(name: str, trace_id: str, sample: float) -> bool:
    """A fixed share of traces, the same ones on every run for one evaluator."""
    if sample >= 1:
        return True
    if sample <= 0:
        return False
    digest = hashlib.sha256(f"{trace_id}:{name}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64 < sample


def _checked(ev: OnlineEvaluator, result: Any) -> dict[str, Any]:
    if not isinstance(result, dict) or set(result) != set(ev.outputs):
        raise ValueError(f"The evaluator '{ev.name}' must return exactly the outputs {sorted(ev.outputs)}.")
    for out, kind in ev.outputs.items():
        value = result[out]
        want = OUTPUT_TYPES[kind]
        # A bool is an int in Python but not a float score, and a number is not a bool.
        if type(value) is not want and not (want is float and type(value) is int):
            raise ValueError(f"The output '{out}' of the evaluator '{ev.name}' must be a {kind}.")
        if want is float and not math.isfinite(value):
            raise ValueError(f"The output '{out}' of the evaluator '{ev.name}' must be a finite number.")
    return {ev.key(out): float(v) if ev.outputs[out] == "float" else v for out, v in result.items()}


def run_evaluators(
    store: TraceStore, *, since: str | None, names: list[str] | None, sample: float, limit: int, rerun: bool = False,
    extra: list[OnlineEvaluator] | None = None,
) -> ReviewResult:
    """Score stored traces with the registered evaluators (all, or `names`).

    `sample` is a fraction from 0 to 1. A trace that already holds every score of
    an evaluator's current version is skipped unless `rerun`. Raises `ValueError`
    for a name that is not registered.
    """
    chosen = list(EVALUATORS.values())
    if names is not None:
        for name in names:
            if name not in EVALUATORS:
                raise ValueError(f"There is no online evaluator named '{name}'. The evaluators are: {', '.join(sorted(EVALUATORS)) or 'none'}.")
        chosen = [EVALUATORS[n] for n in dict.fromkeys(names)]
    chosen += extra or []  # built-ins that are never registered, such as relevance
    result = ReviewResult(by_evaluator={ev.label: 0 for ev in chosen})
    traces = store.traces(since=since, limit=limit)
    result.traces = len(traces)
    for trace in traces:
        for ev in chosen:
            if not _chosen(ev.name, trace.trace_id, sample):
                continue
            if not rerun and all(ev.key(o) in trace.scores for o in ev.outputs):
                result.skipped += 1
                continue
            try:
                scores = _checked(ev, ev.fn(trace.model_copy(deep=True)))
            except SkipTrace:
                result.skipped += 1
                continue
            except Exception as exc:  # a plugin's failure must not stop the batch
                by_type = result.failures.setdefault(ev.label, {})
                by_type[type(exc).__name__] = by_type.get(type(exc).__name__, 0) + 1
                continue
            store.save_scores(trace.trace_id, scores)
            result.scored += 1
            result.by_evaluator[ev.label] += 1
    return result
