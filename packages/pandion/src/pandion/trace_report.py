"""Read traces back: one trace as text, and a summary of many for `pandion report`.

Provisional. It only reads what a `TraceStore` already holds; it never writes and
prints no more than the record or the summary shows.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel

from pandion.trace_record import TraceRecord


#: `pandion report` reads at most this many traces, newest first.
TRACE_LIMIT = 10_000


class TraceReport(BaseModel):
    turns: int = 0
    by_label: dict[str, int] = {}
    flagged: dict[str, int] = {}
    p50_ms: float = 0
    p95_ms: float = 0
    cost_total: float = 0
    #: Mean over the turns that have a cost; None when none do.
    cost_mean: float | None = None
    feedback: dict[str, int] = {}
    #: Mean of each numeric evaluator score.
    score_means: dict[str, float] = {}
    #: How often each boolean or text score value came up, as "name: value".
    score_counts: dict[str, int] = {}
    #: True when the store held more traces than were read, so the numbers cover only the newest.
    capped: bool = False


def _percentile(sorted_values: list[float], q: float) -> float:
    """Linear interpolation between the closest ranks."""
    if not sorted_values:
        return 0
    at = (len(sorted_values) - 1) * q
    low, high = math.floor(at), math.ceil(at)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (at - low)


def summarise_traces(traces: list[TraceRecord]) -> TraceReport:
    latencies = sorted(t.latency_ms for t in traces)
    costs = [t.cost for t in traces if t.cost is not None]
    sums: dict[str, list[float]] = {}
    counts: Counter[str] = Counter()
    for t in traces:
        for name, value in t.scores.items():
            if isinstance(value, bool) or isinstance(value, str):
                counts[f"{name}: {value}"] += 1
            else:
                sums.setdefault(name, []).append(float(value))
    return TraceReport(
        turns=len(traces),
        by_label=dict(Counter(t.label for t in traces if t.label)),
        flagged=dict(Counter(f for t in traces for f in t.flags)),
        p50_ms=round(_percentile(latencies, 0.5), 2), p95_ms=round(_percentile(latencies, 0.95), 2),
        cost_total=sum(costs), cost_mean=sum(costs) / len(costs) if costs else None,
        feedback=dict(Counter(f.value for t in traces for f in t.feedback)),
        score_means={name: sum(v) / len(v) for name, v in sums.items()},
        score_counts=dict(counts), capped=len(traces) >= TRACE_LIMIT,
    )


_DURATION = re.compile(r"([0-9]+)([hd])")


def _bad_since(text: str) -> str:
    return f"--since '{text}' is not a duration like 24h or 7d, nor an ISO 8601 date like 2026-10-01."


def parse_since(text: str, *, now: datetime | None = None) -> str:
    """`24h`, `7d` or an ISO 8601 date or time, as a UTC ISO time. Anything else is a ValueError."""
    now = now or datetime.now(UTC)
    match = _DURATION.fullmatch(text.strip())
    if match and int(match[1]) > 0:
        unit = "hours" if match[2] == "h" else "days"
        try:
            return (now - timedelta(**{unit: int(match[1])})).astimezone(UTC).isoformat(timespec="seconds")
        except OverflowError:
            pass
        raise ValueError(_bad_since(text))
    try:
        when = datetime.fromisoformat(text.strip())
    except ValueError:
        raise ValueError(_bad_since(text)) from None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).isoformat(timespec="seconds")


_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f]")


def _clean(text: str) -> str:
    """User text with control characters (such as terminal escapes) removed; newlines stay."""
    return _CONTROL.sub("", text)


def _money(value: float | None) -> str:
    return "none" if value is None else f"${value:.4f}"


def format_trace(t: TraceRecord) -> str:
    lines = [
        f"Trace {t.trace_id} ({t.created_at}), user {t.user_id}, conversation {t.conversation_id}",
        f"Question: {_clean(t.question)}",
    ]
    if t.standalone and t.standalone != t.question:
        lines.append(f"Searched as: {_clean(t.standalone)}")
    lines += [
        f"Answer: {_clean(t.answer)}",
        f"Label: {t.label or 'none'}. Sources: {', '.join(t.source_ids) or 'none'}.",
        f"Flags: {', '.join(t.flags) or 'none'}.",
        f"Took {t.latency_ms} ms and cost {_money(t.cost)}.",
    ]
    if t.stages:
        width = max(len(s["name"]) for s in t.stages)
        lines.append("Stages:")
        lines += [f"  {s['name']:<{width}}  {s['ms']:>7} ms  {_money(s.get('dollars')):>9}" for s in t.stages]
    if t.scores:
        lines.append("Scores: " + ", ".join(f"{k} {v}" for k, v in t.scores.items()))
    for f in t.feedback:
        lines.append(f"Feedback: {f.value}" + (f" ({f.category})" if f.category else "") + (f": {_clean(f.comment)}" if f.comment else ""))
    return "\n".join(lines)


def format_trace_report(r: TraceReport) -> str:
    if not r.turns:
        return "0 turns."
    lines = [f"{r.turns} turns. Median {r.p50_ms:.0f} ms, 95th percentile {r.p95_ms:.0f} ms."]
    lines.append(f"Cost {_money(r.cost_total)} in all" + (f", {_money(r.cost_mean)} a turn." if r.cost_mean is not None else "."))

    def table(title: str, rows: dict) -> None:
        if rows:
            width = max(len(str(k)) for k in rows)
            lines.append(f"{title}:")
            lines.extend(f"  {k!s:<{width}}  {v}" for k, v in sorted(rows.items(), key=lambda kv: (-kv[1], str(kv[0]))))

    table("Labels", r.by_label)
    table("Flags", r.flagged)
    table("Feedback", r.feedback)
    table("Scores (mean)", {k: round(v, 3) for k, v in r.score_means.items()})
    table("Scores (counts)", r.score_counts)
    return "\n".join(lines)
