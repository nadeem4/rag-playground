"""Speed and cost of one run, from its steps: what every report's `cost()` returns.

Only steps that ran in this run count: executed and failed ones. A cached step
took about no time and used no tokens, so it is counted on its own, in
`steps_cached`. Token counts are what the servers reported (see
`pandion.ports.set_usage`); none are estimated. Dollars are an estimate from a
price table, `pandion.llm.PRICES` unless the caller passes its own.
"""

from __future__ import annotations

from typing import Any, Iterable

from pandion.llm import AS_OF, PRICES
from pandion.results import StageResult

#: The statuses of a step that ran in this run.
_RAN = ("executed", "failed")


def cost(steps: Iterable[StageResult], prices: dict[str, tuple[float, float]] | None = None) -> dict[str, Any]:
    """Seconds, tokens, estimated dollars and the cache share of `steps`.

    `prices` maps a model id to US dollars per million (input, output) tokens
    and replaces `pandion.llm.PRICES`. A step with usage is priced when its
    model has a price and both counts were reported; otherwise its model is
    listed in `unpriced_models`. `dollars` is None when nothing was priced,
    and the token counts are None when no step reported any.
    """
    table = PRICES if prices is None else prices
    steps = list(steps)
    ran = [s for s in steps if s.status in _RAN]
    tokens: dict[str, int | None] = {"input_tokens": None, "output_tokens": None}
    dollars: float | None = None
    unpriced: set[str] = set()
    for s in ran:
        usage = s.usage or {}
        if not usage:
            continue
        for key in tokens:
            if usage.get(key) is not None:
                tokens[key] = (tokens[key] or 0) + usage[key]
        price = table.get(usage.get("model"))
        counts = (usage.get("input_tokens"), usage.get("output_tokens"))
        if price is None or None in counts:
            unpriced.add(str(usage.get("model")))
            continue
        dollars = (dollars or 0.0) + (counts[0] * price[0] + counts[1] * price[1]) / 1_000_000
    return {
        "seconds": sum(s.duration_ms for s in ran) / 1000,
        **tokens,
        "dollars": dollars,
        "unpriced_models": sorted(unpriced),
        "steps_run": len(ran),
        "steps_cached": sum(1 for s in steps if s.status == "cached"),
        "prices_as_of": AS_OF if prices is None else "custom",
    }
