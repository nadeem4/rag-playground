"""`pandion review`: what the batch evaluators and the flags leave for a person to read.

Provisional. It only reads traces and prints; the scoring is `run_evaluators`.
"""

from __future__ import annotations

from pandion.online import ReviewResult
from pandion.trace_record import TraceRecord
from pandion.trace_report import _clean

#: The question is cut to this many characters in the listing.
_SHOWN = 80


def parse_sample(text: str) -> float:
    """`0.02`, `2%` or `1`, as a fraction from 0 to 1. Anything else is a ValueError."""
    try:
        value = float(text[:-1]) / 100 if text.strip().endswith("%") else float(text)
    except ValueError:
        value = -1
    if not 0 <= value <= 1:
        raise ValueError(f"--sample '{text}' is not a share from 0 to 1 (such as 0.02) or from 0% to 100%.")
    return value


def needs_a_look(t: TraceRecord) -> bool:
    return bool(t.flags) or any(f.value == "down" for f in t.feedback)


def format_review_list(traces: list[TraceRecord]) -> str:
    """One line a flagged or thumbs-down trace, newest first, with the question cut short."""
    rows = [t for t in traces if needs_a_look(t)]
    if not rows:
        return "No flagged or thumbs-down traces."
    lines = []
    for t in rows:
        notes = list(t.flags) + (["thumbs down"] if any(f.value == "down" for f in t.feedback) else [])
        question = _clean(t.question).replace("\n", " ")
        question = question if len(question) <= _SHOWN else question[: _SHOWN - 1] + "..."
        lines.append(f"{t.trace_id}  {t.created_at}  {', '.join(notes)}  {question}")
    lines.append("Read one with: pandion trace TRACE_ID")
    return "\n".join(lines)


def format_review_result(r: ReviewResult) -> tuple[str, str]:
    """The summary for stdout, and the failures for stderr (by exception type only)."""
    out = [f"{label}: {n} scored" for label, n in r.by_evaluator.items()]
    out.append(f"{r.traces} traces read, {r.scored} scored, {r.skipped} skipped.")
    err = [
        f"{label}: {sum(kinds.values())} failed ({', '.join(f'{kind}: {n}' for kind, n in sorted(kinds.items()))})"
        for label, kinds in r.failures.items()
    ]
    return "\n".join(out), "\n".join(err)
