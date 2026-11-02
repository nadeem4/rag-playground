"""Dropping old index collections.

A sync makes a new collection and leaves the one before it, so a server on the
previous image or file keeps working. After `GRACE_DAYS` an older collection
nobody keeps is dropped. Only collections named the way Pandion names them
(`<16 hex>-<12 hex>`) are looked at, so other collections in a shared store
(another app's, in one Qdrant prefix or Lance folder) are never touched. A
collection with no readable `created_at` is kept: this never guesses.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from pandion.index_store import IndexStore

#: How long an unkept collection stays before cleanup drops it. Not a setting.
GRACE_DAYS: int = 7

_OURS = re.compile(r"^[0-9a-f]{16}-[0-9a-f]{12}$")


def drop_stale(store: IndexStore, *, keep: set[str], now: datetime, grace_days: int = GRACE_DAYS) -> list[str]:
    """Drop the collections of `store` that Pandion named, that are not in
    `keep` and that are more than `grace_days` old. Returns the dropped names."""
    dropped = []
    for name in store.list():
        if name in keep or not _OURS.match(name):
            continue
        try:
            collection = store.open(name)
            made = datetime.fromisoformat(collection.meta().created_at) if collection else None
            if made is None or made.tzinfo is None or now - made <= timedelta(days=grace_days):
                continue
            store.drop(name)
        except Exception:
            continue  # damaged or unreadable: keep it
        dropped.append(name)
    return dropped
