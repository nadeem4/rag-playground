"""json_file: an index store that keeps one JSON file per collection.

It searches by brute force, so it suits a few thousand rows, not a million. It
shows what the IndexStore contract asks of a store; `store_conformance` proves it.
A store is used from code with `get_store`, and from pipeline.yaml only through an
index step.
"""

import json
import math
import re
from pathlib import Path

from pydantic import BaseModel

from pandion.extend import (
    And, Capabilities, Eq, In, IndexMeta, IndexRow, StoreHit, register_store,
)


class JsonFileSettings(BaseModel):
    folder: str = "json-index"


def _same(a, b) -> bool:
    return isinstance(a, bool) == isinstance(b, bool) and a == b  # True is not 1


def _passes(row: IndexRow, where) -> bool:
    if isinstance(where, And):
        return all(_passes(row, f) for f in where.filters)
    value = getattr(row, where.field) if where.field in ("id", "doc_id", "doc_version", "text", "roles") else row.metadata.get(where.field)
    if value is None:
        return False
    if isinstance(where, Eq):
        return _same(value, where.value)
    wanted = where.values
    if isinstance(where, In):
        return any(_same(value, w) for w in wanted)
    # AnyOf: any overlap. An empty `wanted`, or a row with empty roles, matches nothing.
    return any(_same(v, w) for v in (value if isinstance(value, list) else [value]) for w in wanted)


def _cosine(a: list[float], b: list[float]) -> float:
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb) if na and nb else 0.0


def _words(text: str) -> set[str]:
    return set(re.findall(r"\w+", text.lower()))


class JsonCollection:
    def __init__(self, path: Path, meta: IndexMeta, rows: list[IndexRow]) -> None:
        self.path, self._meta, self.rows = path, meta, rows

    def _save(self) -> None:
        data = {"meta": self._meta.model_dump(), "rows": [r.model_dump() for r in self.rows]}
        self.path.write_text(json.dumps(data), encoding="utf-8")

    def meta(self) -> IndexMeta:
        return self._meta

    def documents(self) -> dict[str, str]:
        return {r.doc_id: r.doc_version for r in self.rows}

    def write_all(self, rows) -> None:
        self.rows = list(rows)
        self._save()

    def replace_document(self, doc_id: str, rows) -> None:
        self.rows = [r for r in self.rows if r.doc_id != doc_id] + list(rows)
        self._save()

    def delete_document(self, doc_id: str) -> None:
        self.rows = [r for r in self.rows if r.doc_id != doc_id]
        self._save()

    def _top(self, scored: list[tuple[float, IndexRow]], k: int) -> list[StoreHit]:
        scored.sort(key=lambda s: (-s[0], s[1].id))
        return [StoreHit(row=r, score=s) for s, r in scored[:k]]

    def search_dense(self, vector, k, where) -> list[StoreHit]:
        # Filter first, then rank: a filter applied after the top k would lose rows.
        return self._top([(_cosine(vector, r.vector), r) for r in self.rows if _passes(r, where)], k)

    def search_lexical(self, text, k, where) -> list[StoreHit]:
        query = _words(text)
        scored = [(float(len(query & _words(r.text))), r) for r in self.rows if _passes(r, where)]
        return self._top([s for s in scored if s[0] > 0], k)


@register_store
class JsonFileStore:
    name = "json_file"
    settings_model = JsonFileSettings

    def __init__(self, settings: JsonFileSettings) -> None:
        self.folder = Path(settings.folder)

    def capabilities(self) -> Capabilities:
        return Capabilities(incremental=True, lexical="fts", filters={"eq", "in", "any_of", "and"}, metrics={"cosine"})

    def _path(self, name: str) -> Path:
        return self.folder / f"{name}.json"

    def create(self, name: str, meta: IndexMeta) -> JsonCollection:
        if self._path(name).exists():
            raise ValueError(f"A collection named '{name}' already exists. Drop it first or pick another name.")
        self.folder.mkdir(parents=True, exist_ok=True)
        collection = JsonCollection(self._path(name), meta, [])
        collection._save()
        return collection

    def open(self, name: str) -> JsonCollection | None:
        if not self._path(name).exists():
            return None
        data = json.loads(self._path(name).read_text(encoding="utf-8"))
        return JsonCollection(self._path(name), IndexMeta(**data["meta"]), [IndexRow(**r) for r in data["rows"]])

    def drop(self, name: str) -> None:
        self._path(name).unlink(missing_ok=True)

    def list(self) -> list[str]:
        return sorted(p.stem for p in self.folder.glob("*.json")) if self.folder.exists() else []
