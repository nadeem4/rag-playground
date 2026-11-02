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


def ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


def test_a_retired_collection_past_the_grace_period_is_dropped():
    store = get_store("memory")
    made(store, name(1), 90)
    assert drop_stale(store, keep=set(), retired={name(1): ago(GRACE_DAYS + 1)}, now=NOW) == [name(1)]
    assert store.list() == []


def test_the_grace_period_counts_from_retirement_not_creation():
    store = get_store("memory")
    made(store, name(1), 90)
    assert drop_stale(store, keep=set(), retired={name(1): ago(1)}, now=NOW) == []


def test_the_current_and_the_previous_collection_are_kept_whatever_their_age():
    store = get_store("memory")
    for n in (1, 2, 3):
        made(store, name(n), 90)
    retired = {name(n): ago(90) for n in (1, 2, 3)}
    assert drop_stale(store, keep={name(1), name(2)}, retired=retired, now=NOW) == [name(3)]
    assert store.list() == [name(1), name(2)]


def test_a_collection_this_manifest_never_retired_is_never_dropped():
    store = get_store("memory")
    made(store, name(1), 90)
    assert drop_stale(store, keep=set(), retired={}, now=NOW) == []


def test_a_retired_at_that_cannot_be_read_keeps_the_collection():
    store = get_store("memory")
    made(store, name(1), 90)
    assert drop_stale(store, keep=set(), retired={name(1): "last tuesday"}, now=NOW) == []


@pytest.mark.parametrize(
    "other", ["notes", "ABCDEF0123456789-abcdef012345", "0123456789abcdef-0123456789abcde", "x" * 29]
)
def test_a_collection_with_another_naming_scheme_is_never_touched(other):
    store = get_store("memory")
    made(store, other, 90)
    assert drop_stale(store, keep=set(), retired={other: ago(90)}, now=NOW) == []
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
    assert drop_stale(store, keep=set(), retired={name(1): ago(90), name(2): ago(90)}, now=NOW) == [name(2)]


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


def retire_long_ago(config: Path, collection: str, days: float = 90) -> None:
    """Pretend this manifest retired the collection `days` ago."""
    path = config.parent / "index" / MANIFEST
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("retired", {})[collection] = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    path.write_text(json.dumps(data), encoding="utf-8")


def built_days_ago(config: Path, collection: str, days: float) -> None:
    """Pretend the collection was built `days` ago."""
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


def manifest_of(config: Path) -> dict:
    return json.loads((config.parent / "index" / MANIFEST).read_text(encoding="utf-8"))


def test_a_sync_retires_the_replaced_collection_and_drops_it_after_the_grace_period(setup):
    config, docs = setup
    one = sync(config, docs).index.output["collection"]
    add(docs, "b.pdf", "Berlin is the capital of Germany.")
    two = sync(config, docs).index.output["collection"]
    assert list(manifest_of(config)["retired"]) == [one]
    add(docs, "c.pdf", "Rome is the capital of Italy.")
    three = sync(config, docs).index.output["collection"]
    assert set(lance(config).list()) == {one, two, three}  # one is retired but young
    retire_long_ago(config, one)
    add(docs, "d.pdf", "Madrid is the capital of Spain.")
    four = sync(config, docs).index.output["collection"]

    assert set(lance(config).list()) == {two, three, four}  # one is gone; two is retired and young
    assert one not in manifest_of(config)["retired"]


def test_a_collection_built_long_ago_and_replaced_today_survives_quick_syncs(setup):
    config, docs = setup
    one = sync(config, docs).index.output["collection"]
    built_days_ago(config, one, 30)
    for i, text in enumerate(["Berlin is a city.", "Rome is a city."]):
        add(docs, f"n{i}.pdf", text)
        sync(config, docs)
    assert one in lance(config).list()


def test_a_sync_never_drops_the_live_collection_of_another_pipeline_in_the_same_store(setup):
    config, docs = setup
    sync(config, docs)
    other = config.parent / "other"
    other.mkdir()
    # A second pipeline on the same Lance location, with another recipe.
    (other / "pipeline.yaml").write_text(
        CONFIG.replace("chunk_size: 70", "chunk_size: 90").replace("path: ./index", f"path: {config.parent / 'index'}"),
        encoding="utf-8",
    )
    theirs = sync(other / "pipeline.yaml", docs).index.output["collection"]
    built_days_ago(config, theirs, 30)
    for text in ("Berlin is a city.", "Rome is a city."):
        add(docs, f"{text[:4]}.pdf", text)
        sync(config, docs)
    assert theirs in lance(config).list()


def test_a_failed_sync_drops_nothing(setup):
    config, docs = setup
    one = sync(config, docs).index.output["collection"]
    add(docs, "b.pdf", "Berlin is the capital of Germany.")
    two = sync(config, docs).index.output["collection"]
    retire_long_ago(config, one)
    (docs / "a.pdf").unlink()
    (docs / "b.pdf").unlink()
    (docs / "bad.pdf").write_bytes(b"not a pdf")
    report = sync(config, docs)

    assert report.index.output is None
    assert {one, two} <= set(lance(config).list())
    assert json.loads((config.parent / "index" / MANIFEST).read_text())["index_collection"] == two


def test_cleanup_in_one_qdrant_prefix_never_touches_another(tmp_path):
    pytest.importorskip("qdrant_client")
    here = {"location": str(tmp_path / "q")}
    mine = get_store("qdrant", {**here, "prefix": "mine"})
    theirs = get_store("qdrant", {**here, "prefix": "theirs"})
    made(mine, name(1), 90)
    made(theirs, name(2), 90)

    assert drop_stale(mine, keep=set(), retired={name(1): ago(90)}, now=NOW) == [name(1)]
    assert theirs.list() == [name(2)]


def test_dropping_a_collection_deletes_its_index_record(setup):
    config, docs = setup
    first = sync(config, docs)
    one = first.index.output["collection"]
    add(docs, "b.pdf", "Berlin is the capital of Germany.")
    sync(config, docs)
    add(docs, "c.pdf", "Rome is the capital of Italy.")
    sync(config, docs)
    assert Pipeline.from_file(config).index.store.has(first.index.artifact_id)  # retired but young
    retire_long_ago(config, one)
    add(docs, "d.pdf", "Madrid is the capital of Spain.")
    sync(config, docs)

    assert one not in lance(config).list()
    assert not Pipeline.from_file(config).index.store.has(first.index.artifact_id)
