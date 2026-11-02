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


def test_not_ready_when_the_collection_is_from_a_newer_pandion(tmp_path, docs, monkeypatch):
    file = config(tmp_path)
    pipeline(file).index.sync(docs)
    real = type(get_store("lancedb", {"location": str(tmp_path)}))
    original = real.open

    def open(self, name):
        found = original(self, name)
        found.meta().format_version = 2
        return found

    monkeypatch.setattr(real, "open", open)
    status = pipeline(file).index.index_status()
    assert not status.ready and "upgrade pandion" in status.reason.lower()


def test_two_servers_with_two_recipes_are_each_ready_against_their_own_collection(tmp_path, docs):
    one, two = config(tmp_path, 70, name="one.yaml"), config(tmp_path, 90, name="two.yaml")
    first = pipeline(one).index.sync(docs).index.output["collection"]
    # Same path, so the second sync replaces the manifest; each server checks its own recipe.
    second = pipeline(two).index.sync(docs).index.output["collection"]
    assert first != second
    assert pipeline(two).index.index_status().ready
    assert not pipeline(one).index.index_status().ready  # its manifest now names the other recipe's collection
    assert first in get_store("lancedb", {"location": str(tmp_path / "index" / "index")}).list()


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
