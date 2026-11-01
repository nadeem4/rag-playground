"""The reference index store: rows in a dict, pure Python, nothing to install.

It is the store the conformance suite is proven on, and the one tests use.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence

from pydantic import BaseModel

from pandion.index_store import (
    Capabilities, Filter, IndexMeta, IndexRow, StoreHit, matches, register_store,
)


class MemorySettings(BaseModel):
    pass


def _words(text: str) -> set[str]:
    return set(re.findall(r"[^\W\d_]+", text.lower()))


class MemoryCollection:
    def __init__(self, meta: IndexMeta):
        self._meta = meta
        self._rows: dict[str, IndexRow] = {}

    def meta(self) -> IndexMeta:
        return self._meta

    def _check(self, row: IndexRow) -> None:
        if len(row.vector) != self._meta.dims:
            raise ValueError(
                f"Row '{row.id}' has {len(row.vector)} numbers but this collection's dims is {self._meta.dims}. "
                "Embed with the same model."
            )

    def documents(self) -> dict[str, str]:
        return {r.doc_id: r.doc_version for r in self._rows.values()}

    def write_all(self, rows: Iterable[IndexRow]) -> None:
        rows = list(rows)
        for r in rows:
            self._check(r)
        self._rows = {r.id: r for r in rows}

    def replace_document(self, doc_id: str, rows: Sequence[IndexRow]) -> None:
        for r in rows:
            self._check(r)
        self.delete_document(doc_id)
        for r in rows:
            self._rows[r.id] = r

    def delete_document(self, doc_id: str) -> None:
        self._rows = {i: r for i, r in self._rows.items() if r.doc_id != doc_id}

    def _score(self, a: list[float], b: list[float]) -> float:
        metric = self._meta.metric
        dot = sum(x * y for x, y in zip(a, b))
        if metric == "dot":
            return dot
        if metric == "l2":
            return -math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
        return dot / (na * nb) if na and nb else 0.0

    def search_dense(self, vector: list[float], k: int, where: Filter) -> list[StoreHit]:
        hits = [StoreHit(row=r, score=self._score(vector, r.vector)) for r in self._rows.values() if matches(r, where)]
        hits.sort(key=lambda h: (-h.score, h.row.id))
        return hits[:k]

    def search_lexical(self, text: str, k: int, where: Filter) -> list[StoreHit]:
        query = _words(text)
        hits = []
        for r in self._rows.values():
            if matches(r, where):
                score = len(query & _words(r.text))
                if score:
                    hits.append(StoreHit(row=r, score=float(score)))
        hits.sort(key=lambda h: (-h.score, h.row.id))
        return hits[:k]


@register_store
class MemoryStore:
    name = "memory"
    settings_model = MemorySettings

    def __init__(self, settings: MemorySettings):
        self.settings = settings
        self._collections: dict[str, MemoryCollection] = {}

    def capabilities(self) -> Capabilities:
        return Capabilities(
            incremental=True, lexical="fts",
            filters={"eq", "in", "any_of", "and"}, metrics={"cosine", "dot", "l2"},
        )

    def create(self, name: str, meta: IndexMeta) -> MemoryCollection:
        if name in self._collections:
            raise ValueError(f"A collection named '{name}' already exists. Drop it first or pick another name.")
        self._collections[name] = MemoryCollection(meta)
        return self._collections[name]

    def open(self, name: str) -> MemoryCollection | None:
        return self._collections.get(name)

    def drop(self, name: str) -> None:
        self._collections.pop(name, None)

    def list(self) -> list[str]:
        return sorted(self._collections)
