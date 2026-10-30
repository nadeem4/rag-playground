"""Which category a document goes to."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pandion.config import RouteRule


@dataclass(frozen=True)
class Sorting:
    """The category a document goes to, and why."""

    category: str
    reason: str


def sort_document(route: list[RouteRule], info: Any, *, pinned: str | None = None) -> Sorting:
    """A pinned category wins; otherwise the first rule with no `when`. Checks
    are not evaluated yet, so only a rule without `when` can match."""
    if pinned is not None:
        return Sorting(pinned, "Chosen when added")
    for rule in route:
        if rule.when is None:
            return Sorting(rule.category, "Default: no rule matched")
    raise ValueError("No route rule matched and none is a default.")
