"""Grace-period cleanup of older collections, and what a sync does with it."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from pandion import Pipeline
from pandion.index_retention import GRACE_DAYS, drop_stale
from pandion.index_store import IndexMeta, get_store
from pandion.manifest import MANIFEST
from pdfs import SAMPLE_PAGES, build_pdf

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


def name(n: int) -> str:
    return f"{n:016x}-{n:012x}"


def made(store, collection: str, days_ago: float | None) -> None:
    created = "" if days_ago is None else (NOW - timedelta(days=days_ago)).isoformat()
    store.create(collection, IndexMeta(
        embed_model="m", embed_revision="1", dims=2, metric="cosine", recipe_hash="h", created_at=created))


def test_a_collection_older_than_the_grace_period_that_nobody_keeps_is_dropped():
    store = get_store("memory")
    made(store, name(1), GRACE_DAYS + 1)
    assert drop_stale(store, keep=set(), now=NOW) == [name(1)]
    assert store.list() == []


def test_the_current_and_the_previous_collection_are_kept_whatever_their_age():
    store = get_store("memory")
    for n in (1, 2, 3):
        made(store, name(n), 90)
    assert drop_stale(store, keep={name(1), name(2)}, now=NOW) == [name(3)]
    assert store.list() == [name(1), name(2)]


def test_a_young_collection_is_kept():
    store = get_store("memory")
    made(store, name(1), GRACE_DAYS - 1)
    assert drop_stale(store, keep=set(), now=NOW) == []


def test_a_collection_with_no_created_at_is_kept():
    store = get_store("memory")
    made(store, name(1), None)
    assert drop_stale(store, keep=set(), now=NOW) == []


def test_a_created_at_that_cannot_be_read_is_kept():
    store = get_store("memory")
    made(store, name(1), 90)
    store.open(name(1)).meta().created_at = "last tuesday"
    assert drop_stale(store, keep=set(), now=NOW) == []


@pytest.mark.parametrize(
    "other", ["notes", "ABCDEF0123456789-abcdef012345", "0123456789abcdef-0123456789abcde", "x" * 29]
)
def test_a_collection_with_another_naming_scheme_is_never_touched(other):
    store = get_store("memory")
    made(store, other, 90)
    assert drop_stale(store, keep=set(), now=NOW) == []
    assert store.list() == [other]


def test_a_collection_that_will_not_open_is_skipped():
    store = get_store("memory")
    made(store, name(1), 90)
    made(store, name(2), 90)
    real = store.open

    def open(n):
        if n == name(1):
            raise RuntimeError("damaged")
        return real(n)

    store.open = open
    assert drop_stale(store, keep=set(), now=NOW) == [name(2)]


CONFIG = """\
path: ./index
models: {device: cpu}
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character, chunk_size: 70, chunk_overlap: 10}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
"""


@pytest.fixture
def setup(tmp_path: Path):
    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG, encoding="utf-8")
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "a.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return config, docs


def lance(config: Path):
    return get_store("lancedb", {"location": str(config.parent / "index" / "index")})


def age(config: Path, collection: str, days: float) -> None:
    """Pretend the collection was made `days` ago."""
    import lancedb

    meta = lance(config).open(collection).meta().model_copy(
        update={"created_at": (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()})
    table = lancedb.connect(str(config.parent / "index" / "index")).open_table("_pandion_meta")
    table.update(where=f"name = '{collection}'", values={"meta_json": meta.model_dump_json()})
    del table


def sync(config, docs):
    return Pipeline.from_file(config).index.sync(docs)


def add(docs, file: str, text: str) -> None:
    (docs / file).write_bytes(build_pdf([[text]]))


def test_a_sync_drops_an_old_unkept_collection_and_keeps_current_and_previous(setup):
    config, docs = setup
    one = sync(config, docs).index.output["collection"]
    add(docs, "b.pdf", "Berlin is the capital of Germany.")
    two = sync(config, docs).index.output["collection"]
    add(docs, "c.pdf", "Rome is the capital of Italy.")
    age(config, one, 90)
    age(config, two, 90)
    three = sync(config, docs).index.output["collection"]

    assert set(lance(config).list()) == {two, three}  # one is old and no longer the previous


def test_a_young_collection_of_another_recipe_survives_a_sync(setup):
    config, docs = setup
    sync(config, docs)
    other = name(7)
    made(lance(config), other, 0)
    add(docs, "b.pdf", "Berlin is the capital of Germany.")
    sync(config, docs)
    assert other in lance(config).list()


def test_a_failed_sync_drops_nothing(setup):
    config, docs = setup
    one = sync(config, docs).index.output["collection"]
    add(docs, "b.pdf", "Berlin is the capital of Germany.")
    two = sync(config, docs).index.output["collection"]
    age(config, one, 90)
    (docs / "a.pdf").unlink()
    (docs / "b.pdf").unlink()
    (docs / "bad.pdf").write_bytes(b"not a pdf")
    report = sync(config, docs)

    assert report.index is None
    assert {one, two} <= set(lance(config).list())
    assert json.loads((config.parent / "index" / MANIFEST).read_text())["index_collection"] == two
