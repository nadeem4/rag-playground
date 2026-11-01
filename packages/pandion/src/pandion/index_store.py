"""The index store contract: where an index's rows live.

`IndexStore` and `Collection` are Stable contracts. A store keeps rows, applies
a `Filter` before it ranks, and says honestly what it can do in `Capabilities`.
Pandion does the rest: chunking, embedding, the roles a search adds, fusion and
reranking. `register_store` adds a store by name, and
`pandion.testing.store_conformance` checks that it keeps the contract.

A row's `roles` list says who may see it. An empty list means nobody.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import ClassVar, Literal, Protocol

from pydantic import BaseModel

MetaValue = str | int | float | bool | list[str]
Metric = Literal["cosine", "dot", "l2"]


class IndexRow(BaseModel):
    id: str
    doc_id: str
    doc_version: str
    text: str
    vector: list[float]
    roles: list[str] = []
    metadata: dict[str, MetaValue] = {}
    chunk: str


class IndexMeta(BaseModel):
    embed_model: str
    embed_revision: str
    dims: int
    metric: Metric
    recipe_hash: str
    format_version: int = 1


class StoreHit(BaseModel):
    row: IndexRow
    score: float  # higher is better; comparable only within one search


@dataclass(frozen=True)
class Eq:
    field: str
    value: MetaValue


@dataclass(frozen=True)
class In:
    field: str
    values: tuple[MetaValue, ...]


@dataclass(frozen=True)
class AnyOf:
    field: str
    values: tuple[str, ...]


@dataclass(frozen=True)
class And:
    filters: tuple["Filter", ...]


Filter = Eq | In | AnyOf | And
NO_FILTER = And(())

_ROW_FIELDS = ("id", "doc_id", "doc_version", "text", "roles")


def _read(row: IndexRow, field: str):
    if field in _ROW_FIELDS:
        return getattr(row, field)
    return row.metadata.get(field)


def _same(a, b) -> bool:
    """Equal, except that a bool never equals a number (True is not 1)."""
    return isinstance(a, bool) == isinstance(b, bool) and a == b


def matches(row: IndexRow, where: Filter) -> bool:
    """Whether a row passes a filter. A missing field matches nothing."""
    if isinstance(where, And):
        return all(matches(row, f) for f in where.filters)
    value = _read(row, where.field)
    if value is None:
        return False
    if isinstance(where, Eq):
        return _same(value, where.value)
    if isinstance(where, In):
        return any(_same(value, v) for v in where.values)
    items = value if isinstance(value, list) else [value]
    return any(v in where.values for v in items)


class Capabilities(BaseModel):
    incremental: bool
    lexical: Literal["bm25", "fts"] | None
    filters: set[Literal["eq", "in", "any_of", "and"]]
    metrics: set[Metric]


class Collection(Protocol):
    def meta(self) -> IndexMeta: ...
    def documents(self) -> dict[str, str]: ...  # doc_id -> doc_version
    def write_all(self, rows: Iterable[IndexRow]) -> None: ...
    def replace_document(self, doc_id: str, rows: Sequence[IndexRow]) -> None: ...
    def delete_document(self, doc_id: str) -> None: ...
    def search_dense(self, vector: list[float], k: int, where: Filter) -> list[StoreHit]: ...
    def search_lexical(self, text: str, k: int, where: Filter) -> list[StoreHit]: ...


class IndexStore(Protocol):
    name: ClassVar[str]
    settings_model: ClassVar[type[BaseModel]]

    def capabilities(self) -> Capabilities: ...
    def create(self, name: str, meta: IndexMeta) -> Collection: ...
    def open(self, name: str) -> Collection | None: ...
    def drop(self, name: str) -> None: ...
    def list(self) -> list[str]: ...


class StoreRefused(ValueError):
    """A store cannot serve what the pipeline asks of it."""


def check_store(name: str, caps: Capabilities, *, lexical: bool = False, metric: str | None = None) -> None:
    """Refuse a pairing the store cannot serve, with one plain sentence."""
    if "any_of" not in caps.filters:
        raise StoreRefused(
            f"The {name} store cannot filter by any of a list of roles, so it cannot keep documents private. "
            "Use another store."
        )
    if lexical and caps.lexical is None:
        raise StoreRefused(
            f"The {name} store has no text search, so BM25 or hybrid retrieval cannot use it. "
            "Use dense retrieval or another store."
        )
    if metric is not None and metric not in caps.metrics:
        have = ", ".join(sorted(caps.metrics))
        raise StoreRefused(f"The {name} store does not support the {metric} metric; it has {have}. Pick one of those.")


_STORES: dict[str, type] = {}


def register_store(cls: type) -> type:
    """Add a store by its `name`. A second store with the same name is refused."""
    old = _STORES.get(cls.name)
    if old is not None and old is not cls:
        raise ValueError(
            f"Two index stores are named '{cls.name}': one in {old.__module__} and one in {cls.__module__}. "
            "Rename one of them."
        )
    _STORES[cls.name] = cls
    return cls


def _load_builtin() -> None:
    import pandion.index_memory  # noqa: F401  (registers the memory store)


def store_names() -> tuple[str, ...]:
    _load_builtin()
    return tuple(sorted(_STORES))


def store_class(name: str) -> type:
    _load_builtin()
    return _STORES[name]


def get_store(name: str, settings: dict | None = None) -> IndexStore:
    _load_builtin()
    cls = _STORES.get(name)
    if cls is None:
        known = ", ".join(sorted(_STORES))
        raise ValueError(f"There is no index store named '{name}'. The stores are: {known}.")
    return cls(cls.settings_model(**(settings or {})))
