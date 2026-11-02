"""Dropping old index collections.

A sync makes a new collection and leaves the one before it, so a server on the
previous image or file keeps working. The manifest records each collection it
replaced in `retired`, with the time. After `GRACE_DAYS` from that time, a
retired collection that is neither the current nor the previous one is dropped.
Only names in `retired` are looked at, so a collection another pipeline made in
the same folder or Qdrant prefix is never touched, whatever its age.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from pandion.index_store import IndexStore

#: How long a replaced collection stays before cleanup drops it. Not a setting.
GRACE_DAYS: int = 7

_OURS = re.compile(r"^[0-9a-f]{16}-[0-9a-f]{12}$")


def drop_stale(
    store: IndexStore, *, keep: set[str], retired: dict[str, str], now: datetime, grace_days: int = GRACE_DAYS
) -> list[str]:
    """Drop the collections in `retired` (name -> when it was replaced, ISO 8601, UTC)
    that Pandion named, are not in `keep` and were replaced more than `grace_days`
    ago. A time that cannot be read keeps the collection. Returns the dropped names."""
    dropped = []
    for name, when in retired.items():
        if name in keep or not _OURS.match(name):
            continue
        try:
            replaced = datetime.fromisoformat(when)
            if replaced.tzinfo is None or now - replaced <= timedelta(days=grace_days):
                continue
            if store.open(name) is None:
                dropped.append(name)  # already gone: forget it
                continue
            store.drop(name)
        except Exception:
            continue  # damaged or unreadable: keep it
        dropped.append(name)
    return dropped
