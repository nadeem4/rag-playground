"""index_status: ready only when this recipe's own collection exists; and a
cached index whose collection is gone is rebuilt, not trusted."""

import json
import shutil
from pathlib import Path

import pytest

from pandion import Pipeline
from pandion.embeddings import FakeDeterministicEmbedder
from pandion.index_store import IndexMeta, get_store
from pandion.manifest import MANIFEST, Manifest
from pdfs import SAMPLE_PAGES, build_pdf

CONFIG = """\
path: ./index
models: {{device: cpu}}
index:
  parse: {{use: pdfium}}
  chunk: {{use: recursive_character, chunk_size: {size}, chunk_overlap: 10}}
  embed: {{use: fake-deterministic}}
  store: {{use: {store}}}
"""


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "a.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return docs


def config(folder: Path, size: int = 70, store: str = "lancedb", name: str = "pipeline.yaml") -> Path:
    file = folder / name
    file.write_text(CONFIG.format(size=size, store=store), encoding="utf-8")
    return file


def pipeline(file: Path) -> Pipeline:
    return Pipeline.from_file(file)


def manifest(folder: Path) -> dict:
    return json.loads((folder / "index" / MANIFEST).read_text(encoding="utf-8"))


def test_a_sync_writes_the_collection_name_into_the_manifest(tmp_path, docs):
    file = config(tmp_path)
    report = pipeline(file).index.sync(docs)
    assert manifest(tmp_path)["index_collection"] == report.index.output["collection"]


def test_a_manifest_without_index_collection_still_loads_and_the_format_version_stays_1(tmp_path):
    path = tmp_path / MANIFEST
    path.write_text(json.dumps({"format_version": 1, "documents": {}}), encoding="utf-8")
    loaded = Manifest.load(path)
    assert loaded.index_collection is None and loaded.format_version == 1


def test_ready_when_the_collection_of_this_recipe_exists(tmp_path, docs):
    file = config(tmp_path)
    report = pipeline(file).index.sync(docs)
    status = pipeline(file).index.index_status()
    assert status.ready and status.collection == report.index.output["collection"]


def test_not_ready_before_the_first_sync(tmp_path):
    status = pipeline(config(tmp_path)).index.index_status()
    assert not status.ready and status.collection is None and "sync" in status.reason


def test_not_ready_when_the_recipe_differs(tmp_path, docs):
    pipeline(config(tmp_path)).index.sync(docs)
    status = pipeline(config(tmp_path, size=90)).index.index_status()
    assert not status.ready and "recipe" in status.reason


def test_not_ready_when_the_collection_was_dropped(tmp_path, docs):
    report = pipeline(config(tmp_path)).index.sync(docs)
    get_store("lancedb", {"location": str(tmp_path / "index" / "index")}).drop(report.index.output["collection"])
    status = pipeline(config(tmp_path)).index.index_status()
    assert not status.ready and "collection" in status.reason


def test_not_ready_when_the_embedder_revision_changed(tmp_path, docs, monkeypatch):
    file = config(tmp_path)
    pipeline(file).index.sync(docs)
    monkeypatch.setattr(FakeDeterministicEmbedder, "revision", "2")
    status = pipeline(file).index.index_status()
    assert not status.ready and "embedding model" in status.reason


def test_not_ready_when_the_collection_is_from_a_newer_pandion(tmp_path, docs):
    import lancedb

    file = config(tmp_path)
    report = pipeline(file).index.sync(docs)
    name = report.index.output["collection"]
    path = str(tmp_path / "index" / "index")
    meta = get_store("lancedb", {"location": path}).open(name).meta().model_copy(update={"format_version": 2})
    table = lancedb.connect(path).open_table("_pandion_meta")
    table.update(where=f"name = '{name}'", values={"meta_json": meta.model_dump_json()})
    del table
    status = pipeline(file).index.index_status()
    assert not status.ready and "upgrade pandion" in status.reason.lower()


def test_two_servers_with_two_recipes_are_each_ready_against_their_own_collection(tmp_path, docs):
    one, two = config(tmp_path, 70, name="one.yaml"), config(tmp_path, 90, name="two.yaml")
    first = pipeline(one).index.sync(docs).index.output["collection"]
    old_server = pipeline(one).index
    assert old_server.index_status().ready  # it opens its collection once and remembers it
    second = pipeline(two).index.sync(docs).index.output["collection"]
    assert first != second
    new_server = pipeline(two).index
    assert new_server.index_status().ready
    # The manifest now names the new collection; the old server keeps its own.
    assert old_server.index_status().ready and old_server.index_status().collection == first
    assert new_server.index_status().collection == second


def test_the_previous_index_record_stays_so_the_old_server_still_hits_the_cache(tmp_path, docs):
    one, two = config(tmp_path, 70, name="one.yaml"), config(tmp_path, 90, name="two.yaml")
    first = pipeline(one).index.sync(docs)
    pipeline(two).index.sync(docs)
    assert pipeline(one).index.store.has(first.index.artifact_id)
    assert pipeline(one).index.sync(docs).index.status == "cached"


def test_a_store_error_in_the_presence_check_does_not_escape_a_sync(tmp_path, docs, monkeypatch):
    file = config(tmp_path)
    pipeline(file).index.sync(docs)

    def boom(*a, **k):
        raise RuntimeError("store down")

    monkeypatch.setattr("pandion.executor.collection_present", boom)
    assert pipeline(file).index.sync(docs).index.status == "cached"


SEARCH = CONFIG + """retrieve:
  search: {{use: dense, top_k: 5}}
answer: {{use: search}}
"""


def test_a_search_neither_checks_nor_rebuilds_a_missing_collection(tmp_path, docs, monkeypatch):
    file = tmp_path / "pipeline.yaml"
    file.write_text(SEARCH.format(size=70, store="lancedb"), encoding="utf-8")
    report = pipeline(file).index.sync(docs)
    name = report.index.output["collection"]
    store = get_store("lancedb", {"location": str(tmp_path / "index" / "index")})
    store.drop(name)
    calls = []
    monkeypatch.setattr("pandion.executor.collection_present", lambda *a, **k: calls.append(1) or True)

    result = pipeline(file).retrieve("capital")

    assert calls == []  # no extra store round trip on a search
    assert not result.ok  # the missing collection is reported
    assert name not in store.list()  # and not rebuilt


def test_status_does_not_load_any_model(tmp_path, docs, monkeypatch):
    file = config(tmp_path)
    pipeline(file).index.sync(docs)
    calls = []
    monkeypatch.setattr(FakeDeterministicEmbedder, "embed", lambda self, *a, **k: calls.append(1))
    pipeline(file).index.index_status()
    assert calls == []


@pytest.mark.parametrize("store", ["lancedb", "qdrant"])
def test_a_cached_index_whose_collection_is_gone_is_rebuilt(tmp_path, docs, store):
    if store == "qdrant":
        pytest.importorskip("qdrant_client")
    file = config(tmp_path, store=store)
    first = pipeline(file).index.sync(docs)
    collection = first.index.output["collection"]
    settings = {"location": str(tmp_path / "index" / "index")}
    get_store(store, settings).drop(collection)
    assert collection not in get_store(store, settings).list()

    again = pipeline(file).index.sync(docs)

    assert again.index.status == "executed"
    assert collection in get_store(store, settings).list()
    assert pipeline(file).index.index_status().ready


def test_a_deleted_index_folder_is_rebuilt(tmp_path, docs):
    file = config(tmp_path)
    pipeline(file).index.sync(docs)
    shutil.rmtree(tmp_path / "index" / "index")
    again = pipeline(file).index.sync(docs)
    assert again.index.status == "executed" and pipeline(file).index.index_status().ready


def test_created_at_is_kept_by_each_store(tmp_path):
    pytest.importorskip("qdrant_client")
    for name, settings in (
        ("memory", {}),
        ("lancedb", {"location": str(tmp_path / "lance")}),
        ("qdrant", {"location": str(tmp_path / "qdrant")}),
    ):
        store = get_store(name, settings)
        store.create("c", IndexMeta(
            embed_model="m", embed_revision="1", dims=2, metric="cosine", recipe_hash="h",
            created_at="2026-11-01T00:00:00+00:00"))
        reopened = store if name == "memory" else get_store(name, settings)
        assert reopened.open("c").meta().created_at == "2026-11-01T00:00:00+00:00"


def test_an_old_collection_without_created_at_reads_as_empty():
    assert IndexMeta.model_validate_json(
        '{"embed_model":"m","embed_revision":"1","dims":2,"metric":"cosine","recipe_hash":"h"}').created_at == ""
