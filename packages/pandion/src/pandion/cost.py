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

from pandion.llm import AS_OF, PRICES
from pandion.results import StageResult

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


def cost(steps: Iterable[StageResult], prices: dict[str, tuple[float, float]] | None = None) -> dict[str, Any]:
    """Seconds, tokens, estimated dollars and the cache share of `steps`.

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
    steps = list(steps)
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
        dollars = (dollars or 0.0) + (counts[0] * price[0] + counts[1] * price[1]) / 1_000_000
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
