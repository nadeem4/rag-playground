"""The Qdrant index store: rows in Qdrant, embedded (memory or a folder) or on a server.

Checked live on qdrant-client 1.20 (spec 5, T10 spike):
- `QdrantClient(":memory:")` and `QdrantClient(path=...)` both run the whole
  store with no server, and both accept `MatchAny`.
- Scores: cosine and dot come back higher-is-better; EUCLID comes back as the
  distance (nearest first), so the l2 score here is `-distance`.
- LEXICAL: local mode accepts sparse vectors with `Modifier.IDF` and applies the
  IDF weight, so the embedded store has bm25-like text search too. Pandion
  tokenizes (the same rule as the memory store), hashes each token to
  `crc32 % 2**31` as the sparse index and uses the term count as the value. No
  `fastembed` is needed. It has no length normalization, so it is bm25-like, not
  exact BM25.
- A cosine collection returns its vectors normalized, so a row comes back with
  its vector scaled to length 1. Nothing in Pandion reads it.

A collection is the Qdrant collection `<prefix>__<name>`. One point in
`<prefix>__meta` keeps its `IndexMeta` as JSON. A local folder allows one open
client at a time, so all stores on one folder share one client, kept until the
process ends; memory and server stores keep their own. `qdrant_client` is imported only inside
functions.
"""

from __future__ import annotations

import atexit
import json
import math
import os
import re
import zlib
from collections.abc import Iterable, Sequence
from contextlib import contextmanager
from uuid import NAMESPACE_URL, uuid5

from pathlib import Path

from pydantic import BaseModel, ConfigDict, field_validator

from pandion.errors import FormatTooNew, require
from pandion.index_lance import NoRows
from pandion.index_store import (
    AnyOf, And, Capabilities, Eq, Filter, In, IndexMeta, IndexRow, StoreHit, StoreRefused, register_store,
)

_STEP = "The qdrant store"
_DENSE = "dense"
_SPARSE = "text"
_META = "meta"
_ID = "_row_id"  # the row id; not "id", so a point id and a row id are never confused
_PAYLOAD_FIELDS = {_ID, "doc_id", "doc_version", "text", "roles", "chunk"}
_UNFILTERABLE = ("chunk", "chunk_json", "vector")  # row payload; no filter can match it
_BATCH = 256


class QdrantSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    location: str = ":memory:"  # ":memory:" or a folder; both run with no server
    url: str = ""  # a Qdrant server; wins over `location`
    api_key_env: str = ""  # the NAME of an environment variable; the key is never a setting
    prefix: str = "pandion"
    fts: bool = True  # also keep a text index; off means no text search

    @field_validator("prefix")
    @classmethod
    def _no_double_underscore(cls, prefix):
        if "__" in prefix:
            raise ValueError("The prefix cannot contain two underscores in a row, because they end the prefix. Use one.")
        return prefix


def _pid(text: str) -> str:
    return str(uuid5(NAMESPACE_URL, text))


def _tokens(text: str) -> list[str]:
    return re.findall(r"[^\W\d_]+", text.lower())


def _sparse(models, text: str):
    counts: dict[int, float] = {}
    for token in _tokens(text):
        index = zlib.crc32(token.encode("utf-8")) % 2**31
        counts[index] = counts.get(index, 0.0) + 1.0
    return models.SparseVector(indices=list(counts), values=list(counts.values()))


def _eq(models, key: str, value):
    if isinstance(value, bool):
        return models.FieldCondition(key=key, match=models.MatchValue(value=value))
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise NoRows(value)
        # A range, so 1 and 1.0 are the same number; a bool payload is not a number here.
        return models.FieldCondition(key=key, range=models.Range(gte=value, lte=value))
    return models.FieldCondition(key=key, match=models.MatchValue(value=value))


def _in(models, key: str, values):
    if not values:
        raise NoRows(key)
    if any(isinstance(v, float) for v in values):
        raise StoreRefused("The qdrant store can filter in only on whole numbers and text. Use whole numbers or text.")
    texts = [v for v in values if isinstance(v, str)]
    numbers = [v for v in values if isinstance(v, int) and not isinstance(v, bool)]
    flags = [v for v in values if isinstance(v, bool)]
    parts = []
    if texts:
        parts.append(models.FieldCondition(key=key, match=models.MatchAny(any=texts)))
    parts += [_eq(models, key, v) for v in numbers]  # a range each, so 1 matches 1.0
    parts += [models.FieldCondition(key=key, match=models.MatchValue(value=v)) for v in flags]
    return parts[0] if len(parts) == 1 else models.Filter(should=parts)


def to_filter(models, where: Filter):
    """A Qdrant filter for a pandion filter, or None for NO_FILTER. Raises `NoRows` when nothing can match."""
    if isinstance(where, And):
        parts = [p for p in (to_filter(models, f) for f in where.filters) if p is not None]
        return models.Filter(must=parts) if parts else None
    if where.field in _UNFILTERABLE:
        raise NoRows(where.field)
    key = _ID if where.field == "id" else where.field
    if isinstance(where, AnyOf):
        if not where.values:
            raise NoRows(key)
        return models.Filter(must=[models.FieldCondition(key=key, match=models.MatchAny(any=list(where.values)))])
    if where.field == "roles":
        raise NoRows(key)  # roles is a list; only any_of reads a list
    if isinstance(where, Eq):
        return models.Filter(must=[_eq(models, key, where.value)])
    return models.Filter(must=[_in(models, key, where.values)])


_FOLDER_CLIENTS: dict[str, object] = {}


@atexit.register
def _close_folders() -> None:
    for client in _FOLDER_CLIENTS.values():
        try:
            client.close()
        except Exception:
            pass
    _FOLDER_CLIENTS.clear()


class QdrantCollection:
    def __init__(self, store: "QdrantStore", name: str, meta: IndexMeta):
        self._store = store
        self._name = name
        self._meta = meta

    def meta(self) -> IndexMeta:
        return self._meta

    def _check(self, row: IndexRow) -> None:
        if _ID in row.metadata:
            raise ValueError(f"Metadata key '{_ID}' is kept by the qdrant store for the row id; rename it.")
        if len(row.vector) != self._meta.dims:
            raise ValueError(
                f"Row '{row.id}' has {len(row.vector)} numbers but this collection's dims is {self._meta.dims}. "
                "Embed with the same model."
            )

    @staticmethod
    def _point(models, row: IndexRow, fts: bool):
        payload = {
            _ID: row.id, "doc_id": row.doc_id, "doc_version": row.doc_version, "text": row.text,
            "roles": row.roles, "chunk": row.chunk, **row.metadata,
        }
        vector = {_DENSE: row.vector}
        if fts:
            vector[_SPARSE] = _sparse(models, row.text)
        return models.PointStruct(id=_pid(row.id), payload=payload, vector=vector)

    def _upsert(self, client, models, rows: Sequence[IndexRow]) -> None:
        for start in range(0, len(rows), _BATCH):
            batch = rows[start:start + _BATCH]
            client.upsert(self._store._full(self._name), [self._point(models, r, self._store.settings.fts) for r in batch])

    def _delete_where(self, client, models, flt) -> None:
        client.delete(self._store._full(self._name), points_selector=models.FilterSelector(filter=flt))

    def write_all(self, rows: Iterable[IndexRow]) -> None:
        rows = list(rows)
        for r in rows:
            self._check(r)
        models = self._store._models()
        with self._store._use() as client:
            self._delete_where(client, models, models.Filter())
            self._upsert(client, models, rows)

    def replace_document(self, doc_id: str, rows: Sequence[IndexRow]) -> None:
        for r in rows:
            self._check(r)
        models = self._store._models()
        with self._store._use() as client:
            self._delete_where(client, models, self._doc(models, doc_id))
            self._upsert(client, models, list(rows))

    def delete_document(self, doc_id: str) -> None:
        models = self._store._models()
        with self._store._use() as client:
            self._delete_where(client, models, self._doc(models, doc_id))

    @staticmethod
    def _doc(models, doc_id: str):
        return models.Filter(must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=doc_id))])

    def documents(self) -> dict[str, str]:
        found: dict[str, str] = {}
        offset = None
        with self._store._use() as client:
            while True:
                points, offset = client.scroll(
                    self._store._full(self._name), limit=_BATCH, offset=offset,
                    with_payload=["doc_id", "doc_version"], with_vectors=False,
                )
                found.update({p.payload["doc_id"]: p.payload["doc_version"] for p in points})
                if offset is None:
                    return found

    @staticmethod
    def _hit(payload: dict, vector: list[float], score: float) -> StoreHit:
        row = IndexRow(
            id=payload[_ID], doc_id=payload["doc_id"], doc_version=payload["doc_version"], text=payload["text"],
            vector=list(vector), roles=list(payload["roles"] or []), chunk=payload["chunk"],
            metadata={k: v for k, v in payload.items() if k not in _PAYLOAD_FIELDS},
        )
        return StoreHit(row=row, score=score)

    def _search(self, query, using: str, k: int, where: Filter, score) -> list[StoreHit]:
        models = self._store._models()
        try:
            flt = to_filter(models, where)
        except NoRows:
            return []
        with self._store._use() as client:
            found = client.query_points(
                self._store._full(self._name), query=query, using=using, query_filter=flt,
                limit=k + 1, with_payload=True, with_vectors=[_DENSE],  # one extra, so ties at the cut-off order by id
            ).points
        hits = [self._hit(p.payload, p.vector[_DENSE], score(p.score)) for p in found]
        hits.sort(key=lambda h: (-h.score, h.row.id))
        return hits[:k]

    def search_dense(self, vector: list[float], k: int, where: Filter) -> list[StoreHit]:
        sign = -1.0 if self._meta.metric == "l2" else 1.0
        return self._search(list(vector), _DENSE, k, where, lambda s: sign * s)

    def search_lexical(self, text: str, k: int, where: Filter) -> list[StoreHit]:
        if not self._store.settings.fts:
            return []
        query = _sparse(self._store._models(), text)
        if not query.indices:
            return []
        return self._search(query, _SPARSE, k, where, float)


@register_store
class QdrantStore:
    name = "qdrant"
    settings_model = QdrantSettings

    def __init__(self, settings: QdrantSettings):
        self.settings = settings
        self._client = None

    def _models(self):
        return require("qdrant_client.models", extra="qdrant", step=_STEP)

    def _connect(self):
        qc = require("qdrant_client", extra="qdrant", step=_STEP)
        s = self.settings
        if s.url:
            key = ""
            if s.api_key_env:
                key = os.environ.get(s.api_key_env, "")
                if not key:
                    raise ValueError(
                        f"The environment variable {s.api_key_env} holds the Qdrant key and it is not set. Set it and try again."
                    )
            return qc.QdrantClient(url=s.url, api_key=key or None)
        if s.location == ":memory:":
            return qc.QdrantClient(":memory:")
        return qc.QdrantClient(path=s.location)

    @contextmanager
    def _use(self):
        """A client for one call. Memory and servers keep their own; a folder allows one open
        client, so every store on that folder shares one."""
        if self.settings.url or self.settings.location == ":memory:":
            if self._client is None:
                self._client = self._connect()
            yield self._client
            return
        key = str(Path(self.settings.location).resolve())
        if key not in _FOLDER_CLIENTS:
            _FOLDER_CLIENTS[key] = self._connect()
        yield _FOLDER_CLIENTS[key]

    def _full(self, name: str) -> str:
        return f"{self.settings.prefix}__{name}"

    @property
    def _meta_name(self) -> str:
        return self._full(_META)

    def capabilities(self) -> Capabilities:
        return Capabilities(
            incremental=True, lexical="bm25" if self.settings.fts else None,
            filters={"eq", "in", "any_of", "and"}, metrics={"cosine", "dot", "l2"},
        )

    _DISTANCE = {"cosine": "COSINE", "dot": "DOT", "l2": "EUCLID"}

    def create(self, name: str, meta: IndexMeta) -> QdrantCollection:
        if name == _META:
            raise ValueError(f"The collection name '{_META}' is kept for the store itself. Pick another name.")
        models = self._models()
        with self._use() as client:
            if client.collection_exists(self._full(name)):
                raise ValueError(f"A collection named '{name}' already exists. Drop it first or pick another name.")
            client.create_collection(
                self._full(name),
                vectors_config={_DENSE: models.VectorParams(
                    size=meta.dims, distance=getattr(models.Distance, self._DISTANCE[meta.metric]))},
                sparse_vectors_config=(
                    {_SPARSE: models.SparseVectorParams(modifier=models.Modifier.IDF)} if self.settings.fts else None
                ),
            )
            if not client.collection_exists(self._meta_name):
                client.create_collection(
                    self._meta_name, vectors_config=models.VectorParams(size=1, distance=models.Distance.DOT))
            client.upsert(self._meta_name, [models.PointStruct(
                id=_pid(name), vector=[1.0], payload={"name": name, "meta_json": meta.model_dump_json()})])
        return QdrantCollection(self, name, meta)

    def open(self, name: str) -> QdrantCollection | None:
        with self._use() as client:
            if name == _META or not client.collection_exists(self._full(name)):
                return None
            if not client.collection_exists(self._meta_name):
                return None
            found = client.retrieve(self._meta_name, [_pid(name)], with_payload=True)
        if not found:
            return None
        raw = found[0].payload["meta_json"]
        version = json.loads(raw).get("format_version", 1)
        if version > 1:
            raise FormatTooNew(
                f"The collection '{name}' was written in format {version}, which this pandion does not read. "
                "Please upgrade pandion."
            )
        return QdrantCollection(self, name, IndexMeta.model_validate_json(raw))

    def drop(self, name: str) -> None:
        if name == _META:
            return
        models = self._models()
        with self._use() as client:
            if client.collection_exists(self._full(name)):
                client.delete_collection(self._full(name))
            if client.collection_exists(self._meta_name):
                client.delete(self._meta_name, points_selector=models.PointIdsList(points=[_pid(name)]))

    def list(self) -> list[str]:
        head = f"{self.settings.prefix}__"
        with self._use() as client:
            names = [c.name for c in client.get_collections().collections]
        return sorted(n[len(head):] for n in names if n.startswith(head) and n != self._meta_name)
