"""A URL as a document: `index.run`, `sync`, `retrieve` take `http(s)://` items.

The page is fetched (`pandion.fetch.fetch_url`), stored in `sources/` like an
uploaded file, and indexed as an ordinary upload. Its document id is the URL.
A local HTTP server in the test serves the pages; the fake embedder means no
model is loaded.
"""

from __future__ import annotations

import pytest

from pandion import Pipeline
from pandion.fetch import FetchRefused
from pandion.manifest import MANIFEST, Manifest
from pdfs import SAMPLE_PAGES, build_pdf
from test_fetch import Server

HTML = (
    "<html><head><title>Care guide</title></head><body>"
    "<h1>Ferns</h1><p>Ferns need water weekly.</p>"
    "<h2>Light</h2><p>Ferns like deep shade.</p>"
    "</body></html>"
).encode()


@pytest.fixture
def server():
    s = Server()
    yield s
    s.stop()


def pipeline(tmp_path, parse: str = "pdfium", public_only: bool = False) -> Pipeline:
    return Pipeline(
        path=tmp_path / "index",
        models={"device": "cpu", "public_endpoints_only": public_only},
        parse=parse,
        chunk={"use": "recursive_character", "chunk_size": 200, "chunk_overlap": 0},
        embed="fake-deterministic",
        store="lancedb",
        search={"use": "hybrid_rrf", "top_k": 3},
    )


def test_a_pdf_at_a_url_indexes_end_to_end_with_the_url_as_its_id(tmp_path, server):
    server.page("/files/report.pdf", build_pdf(SAMPLE_PAGES), "application/pdf")
    url = server.url("/files/report.pdf")
    p = pipeline(tmp_path)

    report = p.index.run(url)

    assert report.ok, report
    assert list(report.documents) == [url]
    assert p.index.documents[url].filename == "127.0.0.1-files-report.pdf"
    result = p.retrieve("What is the capital of France?")
    assert any("Paris" in hit.chunk.text for hit in result.hits)


def test_an_html_page_at_a_url_indexes_end_to_end(tmp_path, server):
    pytest.importorskip("docling", reason="the docling extra reads HTML")
    server.page("/care", HTML, "text/html; charset=utf-8")
    url = server.url("/care")
    p = pipeline(tmp_path, parse="docling")

    report = p.index.run([url])

    assert report.ok, report
    assert p.index.documents[url].filename == "127.0.0.1-care.html"
    result = p.retrieve("How often do ferns need water?")
    assert any("water weekly" in hit.chunk.text for hit in result.hits)


def test_a_url_and_a_local_file_share_one_pipeline(tmp_path, server):
    server.page("/short", build_pdf([["Paris is the capital of France."]]), "application/pdf")
    url = server.url("/short")
    local = tmp_path / "report.pdf"
    local.write_bytes(build_pdf(SAMPLE_PAGES))
    p = pipeline(tmp_path)

    report = p.index.run([local, url])

    assert report.ok, report
    assert sorted(report.documents) == sorted(["report.pdf", url])


def test_a_mapping_can_name_a_url_document(tmp_path, server):
    server.page("/short", build_pdf([["Paris is the capital of France."]]), "application/pdf")
    p = pipeline(tmp_path)

    report = p.index.run({"capitals.pdf": server.url("/short")})

    assert report.ok, report
    assert list(report.documents) == ["capitals.pdf"]


def test_a_refused_url_stops_the_run_before_any_step(tmp_path, server):
    server.page("/thing", b"PK", "application/zip")
    p = pipeline(tmp_path)

    with pytest.raises(FetchRefused):
        p.index.run(server.url("/thing"))

    store = tmp_path / "index" / "artifacts"
    assert not store.exists() or not any(f for f in store.rglob("*") if f.is_file())


def test_public_endpoints_only_turns_the_guard_on(tmp_path, server):
    server.page("/short", build_pdf([["Paris."]]), "application/pdf")
    p = pipeline(tmp_path, public_only=True)

    with pytest.raises(FetchRefused, match="Only https addresses on port 443"):
        p.index.run(server.url("/short"))


def test_sync_reports_a_changed_page_and_then_nothing_new(tmp_path, server):
    server.page("/short", build_pdf([["Paris is the capital of France."]]), "application/pdf")
    url = server.url("/short")
    local = tmp_path / "report.pdf"
    local.write_bytes(build_pdf(SAMPLE_PAGES))

    first = pipeline(tmp_path).index.sync([local, url])
    assert first.ok and first.added == sorted(["report.pdf", url])

    again = pipeline(tmp_path).index.sync([local, url])
    assert again.added == [] and again.changed == [] and again.removed == []
    assert again.unchanged == sorted(["report.pdf", url])

    server.page("/short", build_pdf([["Rome is the capital of Italy."]]), "application/pdf")
    changed = pipeline(tmp_path).index.sync([local, url])
    assert changed.ok
    assert changed.changed == [url]
    assert changed.unchanged == ["report.pdf"]

    entry = Manifest.load(tmp_path / "index" / MANIFEST).documents[url]
    assert entry["filename"] == "127.0.0.1-short.pdf"


def test_a_new_process_searches_a_synced_url_from_the_manifest(tmp_path, server):
    server.page("/short", build_pdf([["Paris is the capital of France."]]), "application/pdf")
    url = server.url("/short")
    synced = pipeline(tmp_path).index.sync(url)
    assert synced.ok

    fresh = pipeline(tmp_path)
    assert fresh.index.indexed()[url].filename == "127.0.0.1-short.pdf"
    result = fresh.retrieve("What is the capital of France?")
    assert result.ok
    assert any("Paris" in hit.chunk.text for hit in result.hits)


def test_a_local_file_entry_in_the_manifest_has_no_filename(tmp_path):
    local = tmp_path / "report.pdf"
    local.write_bytes(build_pdf(SAMPLE_PAGES))

    pipeline(tmp_path).index.sync(local)

    assert set(Manifest.load(tmp_path / "index" / MANIFEST).documents["report.pdf"]) == {
        "content_hash",
        "chunk_set",
        "category",
        "reason",
    }
