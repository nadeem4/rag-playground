"""sync keeps each document's category, reason and labels in the manifest."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest
from pdfs import SAMPLE_PAGES, build_pdf

from pandion import Pipeline
from pandion.extend import route_check
from pandion.manifest import MANIFEST
from pandion.routing import CHECKS

LEGAL = {"when": {"use": "path", "pattern": "legal/**"}, "category": "reports"}
INDEX = {"embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}}


def chunker(size: int) -> dict:
    return {"use": "recursive_character", "chunk_size": size, "chunk_overlap": 10}


def config(tmp_path: Path, route=None, reports_tokens: int = 70) -> dict:
    return {
        "path": str(tmp_path / "index"),
        "models": {"device": "cpu"},
        "categories": {
            "reports": {"parse": {"use": "pdfium"}, "chunk": chunker(reports_tokens)},
            "text": {"parse": {"use": "pdfium"}, "chunk": chunker(50)},
        },
        "route": route or [LEGAL, {"category": "text"}],
        "index": INDEX,
    }


def make(data: dict) -> Pipeline:
    return Pipeline.from_dict(copy.deepcopy(data))


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    folder = tmp_path / "docs"
    (folder / "legal").mkdir(parents=True)
    (folder / "legal" / "a.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (folder / "b.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return folder


def manifest(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "index" / MANIFEST).read_text(encoding="utf-8"))


def test_sync_saves_category_reason_and_labels(tmp_path, docs):
    p = make(config(tmp_path))
    report = p.index.sync(docs, metadata={"b.pdf": {"team": "ops"}})
    written = manifest(tmp_path)["documents"]
    assert written["legal/a.pdf"] == {
        "content_hash": hashlib.sha256((docs / "legal" / "a.pdf").read_bytes()).hexdigest(),
        "chunk_set": report.documents["legal/a.pdf"].stages["chunk"].artifact_id,
        "category": "reports",
        "reason": "Rule 1: path matches legal/**",
    }
    assert written["b.pdf"]["category"] == "text"
    assert written["b.pdf"]["reason"] == "Default: no rule matched"
    assert written["b.pdf"]["metadata"] == {"team": "ops"}


def test_sync_pins_a_new_document_with_categories(tmp_path, docs):
    p = make(config(tmp_path))
    p.index.sync(docs, categories={"b.pdf": "reports"})
    entry = manifest(tmp_path)["documents"]["b.pdf"]
    assert (entry["category"], entry["reason"]) == ("reports", "Chosen when added")


@pytest.fixture
def counting():
    calls = []

    @route_check("test_counting_check")
    def counting(info, settings):
        calls.append(info.filename)
        return False

    yield calls
    CHECKS.pop("test_counting_check")


def test_sync_does_not_run_checks_again(tmp_path, docs, counting):
    route = [{"when": {"use": "test_counting_check"}, "category": "reports"}, {"category": "text"}]
    make(config(tmp_path, route=route)).index.sync(docs)
    assert sorted(counting) == ["a.pdf", "b.pdf"]
    make(config(tmp_path, route=route)).index.sync(docs)
    assert len(counting) == 2


def test_changed_bytes_keep_the_category(tmp_path, docs):
    make(config(tmp_path)).index.sync(docs)
    (docs / "legal" / "a.pdf").write_bytes(build_pdf([["Rome is the capital of Italy."]]))
    # Even a route that would now send it elsewhere does not move it.
    report = make(config(tmp_path, route=[{"category": "text"}])).index.sync(docs)
    assert report.changed == ["legal/a.pdf"]
    entry = manifest(tmp_path)["documents"]["legal/a.pdf"]
    assert (entry["category"], entry["reason"]) == ("reports", "Rule 1: path matches legal/**")


def test_changing_a_categorys_settings_reruns_only_its_documents(tmp_path, docs):
    make(config(tmp_path)).index.sync(docs)
    report = make(config(tmp_path, reports_tokens=40)).index.sync(docs)
    assert report.config_changed
    assert report.changed == ["legal/a.pdf"]
    assert report.unchanged == ["b.pdf"]
    assert report.documents["b.pdf"].stages["chunk"].status == "cached"
    assert report.documents["legal/a.pdf"].stages["chunk"].status == "executed"


def test_changing_routes_moves_nothing(tmp_path, docs):
    make(config(tmp_path)).index.sync(docs)
    swapped = [{"when": {"use": "path", "pattern": "legal/**"}, "category": "text"}, {"category": "reports"}]
    (docs / "new.pdf").write_bytes(build_pdf([["Berlin is the capital of Germany."]]))
    report = make(config(tmp_path, route=swapped)).index.sync(docs)
    assert report.changed == [] and report.added == ["new.pdf"]
    assert not report.config_changed
    entries = manifest(tmp_path)["documents"]
    assert entries["legal/a.pdf"]["category"] == "reports"
    assert entries["b.pdf"]["category"] == "text"
    assert entries["new.pdf"]["category"] == "reports"


def test_config_changed_follows_category_settings_not_routes(tmp_path, docs):
    make(config(tmp_path)).index.sync(docs)
    assert not make(config(tmp_path, route=[{"category": "text"}])).index.sync(docs).config_changed
    assert make(config(tmp_path, reports_tokens=40)).index.sync(docs).config_changed


def test_removing_a_category_with_documents_is_refused_with_their_names(tmp_path, docs):
    p = make(config(tmp_path))
    first = p.index.sync(docs)
    before = manifest(tmp_path)
    only_text = config(tmp_path, route=[{"category": "text"}])
    del only_text["categories"]["reports"]
    with pytest.raises(ValueError) as e:
        make(only_text).index.sync(docs)
    assert str(e.value) == (
        'These documents are in a category the pipeline no longer has ("reports"): legal/a.pdf. '
        "Move them to another category first, or put the category back."
    )
    assert manifest(tmp_path) == before
    assert p.index.store.has(first.index.artifact_id)


def test_old_manifest_without_category_is_sorted_on_next_sync(tmp_path, docs):
    make(config(tmp_path)).index.sync(docs)
    old = manifest(tmp_path)
    for entry in old["documents"].values():
        del entry["category"], entry["reason"]
    (tmp_path / "index" / MANIFEST).write_text(json.dumps(old), encoding="utf-8")
    report = make(config(tmp_path)).index.sync(docs)
    assert report.unchanged == ["b.pdf", "legal/a.pdf"] and not report.config_changed
    assert manifest(tmp_path)["documents"]["legal/a.pdf"]["category"] == "reports"


def test_old_file_manifest_is_unchanged_for_old_pipelines(tmp_path, docs):
    old = {
        "path": str(tmp_path / "index"),
        "models": {"device": "cpu"},
        "index": {"parse": {"use": "pdfium"}, "chunk": chunker(70), **INDEX},
    }
    report = make(old).index.sync(docs)
    entry = manifest(tmp_path)["documents"]["b.pdf"]
    assert entry["category"] == "default"
    assert entry["content_hash"] == hashlib.sha256((docs / "b.pdf").read_bytes()).hexdigest()
    assert entry["chunk_set"] == report.documents["b.pdf"].stages["chunk"].artifact_id
    # The values main produced for this file and recipe, before categories existed.
    assert entry["chunk_set"] == "83b575deebfa26d6f0096d07664ddddbfd82435a486008b67938801a37aea942"
    assert manifest(tmp_path)["index_recipe"] == "92b08ceb1522957516cdec7457313cb0550ecf7e7cf54c33a611c0a3c77ec71d"
    assert set(entry) == {"content_hash", "chunk_set", "category", "reason"}


def test_a_new_process_searches_with_the_recorded_categories(tmp_path, docs):
    data = config(tmp_path)
    data["retrieve"] = {"search": {"use": "dense"}}
    synced = make(data).index.sync(docs)
    # A route that would sort everything elsewhere must not matter to a new process.
    data["route"] = [{"category": "text"}]
    second = make(data)
    graph, _ = second.index.graph(second.index.indexed())
    sizes = {n.id: n.config["chunk_size"] for n in graph.nodes if n.id.endswith("::chunk")}
    assert sizes == {"b.pdf::chunk": 50, "legal/a.pdf::chunk": 70}
    found = second.retrieval.retrieve("capital of France", k=3)
    assert found.index.artifact_id == synced.index.artifact_id


def test_sync_keeps_the_saved_labels_of_a_document_already_in_the_manifest(tmp_path, docs):
    make(config(tmp_path)).index.sync(docs, metadata={"b.pdf": {"team": "ops"}})
    make(config(tmp_path)).index.sync(docs, metadata={"b.pdf": {"team": "sales"}})
    assert manifest(tmp_path)["documents"]["b.pdf"]["metadata"] == {"team": "ops"}


def test_sync_refuses_categories_for_a_document_already_in_the_manifest(tmp_path, docs):
    p = make(config(tmp_path))
    p.index.sync(docs)
    before = manifest(tmp_path)
    with pytest.raises(ValueError, match="already in the index.*p.index.move"):
        p.index.sync(docs, categories={"b.pdf": "reports"})
    assert manifest(tmp_path) == before


def test_sync_that_drops_every_document_of_a_removed_category_is_refused(tmp_path, docs):
    make(config(tmp_path)).index.sync(docs)
    data = config(tmp_path)
    del data["categories"]["reports"]
    data["route"] = [{"category": "text"}]
    with pytest.raises(ValueError, match="no longer has"):
        make(data).index.sync(docs / "b.pdf")
