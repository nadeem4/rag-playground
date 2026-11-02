"""The LanceDB index store: rows in Lance tables, on a local path, `s3://` or `gs://`.

Checked live on lancedb 0.38 (spec 5):
- `array_has_any(roles, ['a', 'b'])` filters with `prefilter=True`; an empty list matches nothing.
- `table.add_columns(pa.schema([...]))` adds a nullable column to a table that has rows.
- `_distance` is `1 - dot` for "dot" (so the score is `1 - d`), and the squared distance for "l2".

A collection is a table named after it, plus one row in the `_pandion_meta` table
that keeps its `IndexMeta` as JSON (so it also works on object storage). Every
method connects, works and lets go of the handle before it returns, because an
open LanceDB handle turns moving the directory into a WinError 32 on Windows.
LanceDB and pyarrow are imported only inside functions.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Sequence
from typing import Any

from pydantic import BaseModel

from pandion.errors import FormatTooNew, require
from pandion.index_store import (
    Capabilities, AnyOf, And, Eq, Filter, In, IndexMeta, IndexRow, StoreHit, register_store,
)

META_TABLE = "_pandion_meta"
_STEP = "The lancedb store"
_ROW_COLUMNS = ("id", "vector", "text", "doc_id", "doc_version", "roles", "chunk_json")
_UNFILTERABLE = ("chunk", "chunk_json", "vector")  # row payload; no filter can match it


class LanceSettings(BaseModel):
    location: str = ""  # a local path, s3://... or gs://...
    fts: bool = True


class NoRows(Exception):
    """A filter that can match nothing; the search returns no rows."""


def _lit(value) -> tuple[str, str]:
    """(sql text, kind) of a filter value."""
    if isinstance(value, bool):
        return ("true" if value else "false"), "bool"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise NoRows(value)
        return repr(value), "num"
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'", "str"
    raise NoRows(value)


def to_sql(where: Filter, kinds: dict[str, str] | None = None) -> str | None:
    """A LanceDB where-clause for a filter, or None for NO_FILTER.

    `kinds` maps each column to "bool", "num", "str" or "list". With it, a filter on
    a column the table lacks, or on a value of another kind, raises `NoRows`.
    """
    if isinstance(where, And):
        parts = [p for p in (to_sql(f, kinds) for f in where.filters) if p]
        return " AND ".join(f"({p})" for p in parts) if parts else None
    col = where.field
    if col in _UNFILTERABLE:
        raise NoRows(col)
    kind = (kinds or {"roles": "list"}).get(col)
    name = "`" + col.replace("`", "``") + "`"
    if kinds is not None and kind is None:
        raise NoRows(col)
    if isinstance(where, AnyOf):
        if not where.values:
            raise NoRows(col)
        values = ", ".join(_lit(v)[0] for v in where.values)
        if kind == "list" or (kinds is None and col == "roles"):
            return f"array_has_any({name}, [{values}])"
        if kind != "str":
            raise NoRows(col)
        return f"{name} IN ({values})"
    values = (where.value,) if isinstance(where, Eq) else where.values
    if not values:
        raise NoRows(col)
    lits = [_lit(v) for v in values]
    if kinds is not None and any(k != kind for _, k in lits):
        raise NoRows(col)
    if isinstance(where, Eq):
        return f"{name} = {lits[0][0]}"
    return f"{name} IN ({', '.join(s for s, _ in lits)})"


def _quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _arrow_type(pa, value):
    if isinstance(value, bool):
        return pa.bool_()
    if isinstance(value, int):
        return pa.int64()
    if isinstance(value, float):
        return pa.float64()
    if isinstance(value, str):
        return pa.string()
    return pa.list_(pa.string())


def _kind(pa, typ) -> str:
    if pa.types.is_boolean(typ):
        return "bool"
    if pa.types.is_integer(typ) or pa.types.is_floating(typ):
        return "num"
    if pa.types.is_string(typ) or pa.types.is_large_string(typ):
        return "str"
    return "list"


class LanceCollection:
    def __init__(self, store: "LanceStore", name: str, meta: IndexMeta):
        self._store = store
        self._name = name
        self._meta = meta

    def meta(self) -> IndexMeta:
        return self._meta

    # -- helpers -----------------------------------------------------------

    def _check(self, row: IndexRow) -> None:
        if len(row.vector) != self._meta.dims:
            raise ValueError(
                f"Row '{row.id}' has {len(row.vector)} numbers but this collection's dims is {self._meta.dims}. "
                "Embed with the same model."
            )

    def _base_fields(self, pa) -> list:
        return [
            pa.field("id", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), self._meta.dims)),
            pa.field("text", pa.string()),
            pa.field("doc_id", pa.string()),
            pa.field("doc_version", pa.string()),
            pa.field("roles", pa.list_(pa.string())),
            pa.field("chunk_json", pa.string()),
        ]

    def _metadata_types(self, pa, rows: Sequence[IndexRow], known: dict[str, Any]) -> dict[str, Any]:
        """Arrow type of each metadata key: the table's own, else the first value written."""
        types = dict(known)
        for row in rows:
            for key, value in row.metadata.items():
                typ = _arrow_type(pa, value)
                if types.setdefault(key, typ) != typ:
                    raise ValueError(
                        f"Metadata key '{key}' changed type: the collection holds {types[key]} "
                        f"but row '{row.id}' has {typ}. Keep one type per key."
                    )
        return types

    @staticmethod
    def _record(row: IndexRow) -> dict:
        return {
            "id": row.id, "vector": row.vector, "text": row.text, "doc_id": row.doc_id,
            "doc_version": row.doc_version, "roles": row.roles, "chunk_json": row.chunk, **row.metadata,
        }

    def _table_of(self, pa, rows: Sequence[IndexRow], schema):
        return pa.Table.from_pylist([self._record(r) for r in rows], schema=schema)

    def _rebuild_fts(self, table) -> None:
        if self._store.settings.fts:
            from lancedb.index import FTS

            table.create_index("text", config=FTS(), replace=True)

    def _kinds(self, pa, table) -> dict[str, str]:
        return {f.name: _kind(pa, f.type) for f in table.schema}

    def _to_hit(self, record: dict, score: float) -> StoreHit:
        skip = set(_ROW_COLUMNS) | {"_distance", "_score", "_relevance_score"}
        row = IndexRow(
            id=record["id"], doc_id=record["doc_id"], doc_version=record["doc_version"], text=record["text"],
            vector=[float(x) for x in record["vector"]], roles=list(record["roles"] or []),
            chunk=record["chunk_json"],
            metadata={k: v for k, v in record.items() if k not in skip and v is not None},
        )
        return StoreHit(row=row, score=score)

    # -- writes ------------------------------------------------------------

    def write_all(self, rows: Iterable[IndexRow]) -> None:
        pa = require("pyarrow", extra="lancedb", step=_STEP)
        rows = list(rows)
        for r in rows:
            self._check(r)
        types = self._metadata_types(pa, rows, {})
        schema = pa.schema(self._base_fields(pa) + [pa.field(k, t) for k, t in types.items()])
        db = self._store._connect()
        table = db.create_table(self._name, data=self._table_of(pa, rows, schema), mode="overwrite")
        self._rebuild_fts(table)
        del table, db

    def replace_document(self, doc_id: str, rows: Sequence[IndexRow]) -> None:
        pa = require("pyarrow", extra="lancedb", step=_STEP)
        for r in rows:
            self._check(r)
        db = self._store._connect()
        table = db.open_table(self._name)
        known = {f.name: f.type for f in table.schema if f.name not in _ROW_COLUMNS}
        types = self._metadata_types(pa, rows, known)
        new = [pa.field(k, t) for k, t in types.items() if k not in known]
        table.delete(f"doc_id = {_quote(doc_id)}")
        if new:
            table.add_columns(pa.schema(new))
        if rows:
            table.add(self._table_of(pa, rows, table.schema))
        self._rebuild_fts(table)
        del table, db

    def delete_document(self, doc_id: str) -> None:
        db = self._store._connect()
        table = db.open_table(self._name)
        table.delete(f"doc_id = {_quote(doc_id)}")
        del table, db

    def documents(self) -> dict[str, str]:
        db = self._store._connect()
        table = db.open_table(self._name)
        found = table.search().select(["doc_id", "doc_version"]).limit(table.count_rows() or 1).to_list()
        del table, db
        return {r["doc_id"]: r["doc_version"] for r in found}

    # -- reads -------------------------------------------------------------

    def _search(self, build, where: Filter, k: int, score) -> list[StoreHit]:
        pa = require("pyarrow", extra="lancedb", step=_STEP)
        db = self._store._connect()
        table = db.open_table(self._name)
        try:
            if not table.count_rows():
                return []
            try:
                sql = to_sql(where, self._kinds(pa, table))
            except NoRows:
                return []
            query = build(table)
            if sql:
                query = query.where(sql, prefilter=True)
            found = query.limit(k + 1).to_list()  # one extra, so ties at the cut-off order by id
        finally:
            del table, db
        hits = [self._to_hit(r, score(r)) for r in found]
        hits.sort(key=lambda h: (-h.score, h.row.id))
        return hits[:k]

    def search_dense(self, vector: list[float], k: int, where: Filter) -> list[StoreHit]:
        metric = self._meta.metric

        def score(r: dict) -> float:
            d = r["_distance"]
            return -math.sqrt(max(d, 0.0)) if metric == "l2" else 1.0 - d

        return self._search(lambda t: t.search(vector).distance_type(metric), where, k, score)

    def search_lexical(self, text: str, k: int, where: Filter) -> list[StoreHit]:
        if not text.strip() or not self._store.settings.fts:
            return []
        return self._search(lambda t: t.search(text, query_type="fts"), where, k, lambda r: float(r["_score"]))


@register_store
class LanceStore:
    name = "lancedb"
    settings_model = LanceSettings

    def __init__(self, settings: LanceSettings):
        self.settings = settings

    def _connect(self):
        return require("lancedb", extra="lancedb", step=_STEP).connect(self.settings.location)

    def capabilities(self) -> Capabilities:
        return Capabilities(
            incremental=True, lexical="fts" if self.settings.fts else None,
            filters={"eq", "in", "any_of", "and"}, metrics={"cosine", "dot", "l2"},
        )

    def _tables(self, db) -> list[str]:
        return list(db.list_tables().tables)

    def create(self, name: str, meta: IndexMeta) -> LanceCollection:
        pa = require("pyarrow", extra="lancedb", step=_STEP)
        db = self._connect()
        if name in self._tables(db):
            raise ValueError(f"A collection named '{name}' already exists. Drop it first or pick another name.")
        collection = LanceCollection(self, name, meta)
        db.create_table(name, schema=pa.schema(collection._base_fields(pa)))
        row = [{"name": name, "meta_json": meta.model_dump_json()}]
        if META_TABLE in self._tables(db):
            meta_table = db.open_table(META_TABLE)
            meta_table.delete(f"name = {_quote(name)}")  # a stale row from a half-dropped collection
            meta_table.add(row)
            del meta_table
        else:
            db.create_table(META_TABLE, data=row)
        del db
        return collection

    def open(self, name: str) -> LanceCollection | None:
        db = self._connect()
        if META_TABLE not in self._tables(db) or name not in self._tables(db):
            return None
        found = db.open_table(META_TABLE).search().where(f"name = {_quote(name)}").limit(1).to_list()
        del db
        if not found:
            return None
        version = json.loads(found[0]["meta_json"]).get("format_version", 1)
        if version > 1:
            raise FormatTooNew(
                f"The collection '{name}' was written in format {version}, which this pandion does not read. "
                "Please upgrade pandion."
            )
        return LanceCollection(self, name, IndexMeta.model_validate_json(found[0]["meta_json"]))

    def drop(self, name: str) -> None:
        db = self._connect()
        if name in self._tables(db):
            db.drop_table(name)
        if META_TABLE in self._tables(db):
            db.open_table(META_TABLE).delete(f"name = {_quote(name)}")
        del db

    def list(self) -> list[str]:
        db = self._connect()
        names = sorted(t for t in self._tables(db) if t != META_TABLE)
        del db
        return names
