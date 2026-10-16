"""Speed and cost of one run, from its steps: what every report's `cost()` returns.

Only steps that ran in this run count: executed and failed ones. A cached step
took about no time and used no tokens, so it is counted on its own, in
`steps_cached`, once per report even when several searches read it, and not at
all when the same report also ran it. Token counts are what the servers
reported (see `pandion.ports.set_usage`); none are estimated. Dollars are an estimate from a price table, `pandion.llm.PRICES`
unless the caller passes its own.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from pandion.llm import AS_OF, CACHE_READ_SHARE, PRICES
from pandion.results import StageResult

#: Where each stage falls in a run, in pipeline order. `embed` and `store` are
#: the settings of the one index step, so they share its place.
STAGE_ORDER: dict[str, int] = {
    "source": 0,
    "parse": 1,
    "clean": 2,
    "chunk": 3,
    "enrich": 4,
    "embed": 5,
    "store": 5,
    "index": 5,
    "rewrite": 6,
    "search": 7,
    "rerank": 8,
    "answer": 9,
}

#: The statuses of a step that ran in this run.
_RAN = ("executed", "failed")

#: A snapshot date at the end of a model id: -20251001 or -2024-08-06.
_DATED = re.compile(r"-(\d{8}|\d{4}-\d{2}-\d{2})$")


def _price(usage: dict[str, Any], table: dict[str, tuple[float, float]]) -> tuple[float, float] | None:
    """The price of the served id, of the served id without its date, or of the id asked for."""
    served = usage.get("model")
    for model in (served, _DATED.sub("", served or ""), usage.get("requested_model")):
        if model and model in table:
            return table[model]
    return None


def _place(stage: str) -> int:
    """Where `stage` falls in a run; a ValueError when it is no stage."""
    if stage not in STAGE_ORDER:
        raise ValueError(f"'{stage}' is not a stage. Use one of {', '.join(STAGE_ORDER)}.")
    return STAGE_ORDER[stage]


def _between(steps: list[StageResult], since: str | None, before: str | None) -> list[StageResult]:
    """The steps at `since` or after it and before `before`, in pipeline order."""
    low = _place(since) if since is not None else None
    high = _place(before) if before is not None else None
    if low is None and high is None:
        return steps
    kept = []
    for s in steps:
        place = _place(s.stage)
        if (low is None or place >= low) and (high is None or place < high):
            kept.append(s)
    return kept


def total_cost(
    reports: Iterable[Any],
    *,
    prices: dict[str, tuple[float, float]] | None = None,
    since: str | None = None,
    before: str | None = None,
) -> dict[str, Any]:
    """The cost of several reports together, each step counted once across all of them.

    A cached read of a result that another of the reports ran is not counted,
    and a cached step that several of them read counts once. `prices`,
    `since` and `before` work as in `cost`. `reports` are Pandion's reports:
    `Retrieval`, `Answer`, `IndexReport` (or `SyncReport`), `EvaluationReport`
    or `Comparison`.
    """
    return cost([s for r in reports for s in r._costed()], prices, since=since, before=before)


def varied_costs(
    reports: Iterable[Any],
    *,
    since: str,
    prices: dict[str, tuple[float, float]] | None = None,
) -> list[dict[str, Any]]:
    """Each report's cost from `since` on, as if it had run on its own.

    The variants of one comparison share steps: a list of cleaners or
    rerankers that starts the same way makes the same first results. Whichever
    variant runs first makes them, and the others read them from the cache.
    Here a cached step at or after `since` that another of the reports ran is
    charged to this report too, with the time and tokens of the step that made
    it, and counted as run. So each variant's cost is the same whatever order
    the variants ran in. `total_cost` still counts what was really spent.
    """
    reports = list(reports)
    made: dict[str, StageResult] = {}
    for r in reports:
        for s in _between(r._costed(), since, None):
            if s.status == "executed" and s.artifact_id is not None:
                made.setdefault(s.artifact_id, s)
    return [cost(r._costed(), prices, since=since, charge=made) for r in reports]


def cost(
    steps: Iterable[StageResult],
    prices: dict[str, tuple[float, float]] | None = None,
    *,
    since: str | None = None,
    before: str | None = None,
    charge: dict[str, StageResult] | None = None,
) -> dict[str, Any]:
    """Seconds, tokens, estimated dollars and the cache share of `steps`.

    `since` keeps only the steps at that stage or after it, in pipeline order
    (`STAGE_ORDER`), and `before` only the steps before it, so the two split a
    run in two. An unknown stage name is a ValueError. `charge` maps a result
    id to the step that made it in another run: a cached read of one of them
    is counted as that step, once (see `varied_costs`).

    `prices` maps a model id to US dollars per million (input, output) tokens
    and replaces `pandion.llm.PRICES`. A step with usage is priced when its
    model has a price and both counts were reported. A model with no price is
    listed in `unpriced_models`; a priced model with a missing count is
    listed in `uncounted_models`. `dollars` is None when nothing was priced,
    and the token counts are None when no step reported any. A cached step
    with an artifact id is counted once, however often it was read, and not at
    all when the same report also ran it.
    """
    table = PRICES if prices is None else prices
    steps = _between(list(steps), since, before)
    if charge:
        # A cached step that another run made is charged as that run's step, once.
        own = {s.artifact_id for s in steps if s.status in _RAN}
        charged = []
        for s in steps:
            if s.status == "cached" and s.artifact_id in charge and s.artifact_id not in own:
                own.add(s.artifact_id)
                s = charge[s.artifact_id]
            charged.append(s)
        steps = charged
    ran = [s for s in steps if s.status in _RAN]
    seen: set[str] = {s.artifact_id for s in ran if s.artifact_id is not None}
    cached = 0
    for s in steps:
        if s.status == "cached":
            if s.artifact_id is not None:
                if s.artifact_id in seen:
                    continue
                seen.add(s.artifact_id)
            cached += 1
    tokens: dict[str, int | None] = {"input_tokens": None, "output_tokens": None}
    dollars: float | None = None
    unpriced: set[str] = set()
    uncounted: set[str] = set()
    for s in ran:
        usage = s.usage or {}
        if not usage:
            continue
        for key in tokens:
            if usage.get(key) is not None:
                tokens[key] = (tokens[key] or 0) + usage[key]
        model = usage.get("model")
        price = _price(usage, table)
        counts = (usage.get("input_tokens"), usage.get("output_tokens"))
        if price is None or None in counts:
            if model is not None:
                (unpriced if price is None else uncounted).add(str(model))
            continue
        read = usage.get("cache_read_input_tokens") or 0
        input_dollars = (counts[0] - read) * price[0] + read * price[0] * CACHE_READ_SHARE
        dollars = (dollars or 0.0) + (input_dollars + counts[1] * price[1]) / 1_000_000
    return {
        "seconds": sum(s.duration_ms for s in ran) / 1000,
        **tokens,
        "dollars": dollars,
        "unpriced_models": sorted(unpriced),
        "uncounted_models": sorted(uncounted),
        "steps_run": len(ran),
        "steps_cached": cached,
        "prices_as_of": AS_OF if prices is None else "custom",
    }
