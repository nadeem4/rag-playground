from __future__ import annotations

import hashlib

from pandion.plugins.source import upload
from pandion.ports import RunContext
from pandion.sources import Sources
from tests.api.conftest import upload_pdf


def test_upload_is_content_addressed(client, dirs):
    body = upload_pdf(client, "Paper.PDF")
    assert body["filename"] == "Paper.PDF"
    assert body["size"] > 0
    assert body["content_type"] == "application/pdf"
    # The upload step's naming rule: <sources>/<sha><suffix of the filename>
    assert (dirs["sources"] / f"{body['sha']}.PDF").is_file()


def test_upload_is_idempotent(client, dirs):
    a = upload_pdf(client)
    b = upload_pdf(client)
    assert a == b
    # One stored file for the one upload (the samples seeded at startup aside).
    assert len([p for p in dirs["sources"].iterdir() if p.is_file() and p.name.startswith(a["sha"])]) == 1


def test_empty_upload_is_400(client):
    r = client.post("/api/v2/documents", files={"file": ("e.pdf", b"", "application/pdf")})
    assert r.status_code == 400


def test_uploaded_file_is_findable_by_the_upload_transform(client, dirs):
    body = upload_pdf(client)
    cls = upload.Upload
    ctx = RunContext(
        output_dir=dirs["artifacts"], emit=lambda e: None, tmp=dirs["artifacts"],
        extras={"sources": Sources(dirs["sources"])},
    )
    out = cls().apply({}, cls.config_model(sha=body["sha"], filename=body["filename"]), ctx)
    assert out["path"] == str(dirs["sources"] / f"{body['sha']}.pdf")


def test_list_sources(client):
    assert client.get("/api/v2/documents").json() == []
    body = upload_pdf(client)
    [listed] = client.get("/api/v2/documents").json()
    # the list adds when it was uploaded (tests/api/test_delete_source.py)
    assert {k: v for k, v in listed.items() if k != "uploaded_at"} == body


def test_distinct_bytes_distinct_sha(client):
    a = client.post("/api/v2/documents", files={"file": ("a.txt", b"one", "text/plain")})
    b = client.post("/api/v2/documents", files={"file": ("b.txt", b"two", "text/plain")})
    assert a.json()["sha"] == hashlib.sha256(b"one").hexdigest()
    assert a.json()["sha"] != b.json()["sha"]


# --- POST /api/sources/sample (I-14) ----------------------------------------


import threading  # noqa: E402

from api import sample_set, warmup  # noqa: E402


def test_sample_registers_like_an_upload(client, dirs):
    body = client.post("/api/sources/sample").json()
    data = sample_set.default_sample().pdf.read_bytes()
    assert body == {
        "sha": hashlib.sha256(data).hexdigest(),
        "filename": "chunking-primer.pdf",
        "size": len(data),
        "content_type": "application/pdf",
    }
    assert (dirs["sources"] / f"{body['sha']}.pdf").read_bytes() == data
    assert client.get("/api/v2/documents").json() == [body]


def test_sample_is_idempotent(client, dirs):
    a = client.post("/api/sources/sample").json()
    b = client.post("/api/sources/sample").json()
    assert a == b
    assert len([p for p in dirs["sources"].iterdir() if p.is_file() and p.name.startswith(a["sha"])]) == 1


def test_sample_by_name_registers_that_sample(client, dirs):
    body = client.post("/api/sources/sample", json={"name": "scanned-notes"}).json()
    assert body["filename"] == "scanned-notes.pdf"
    assert (dirs["sources"] / f"{body['sha']}.pdf").exists()


def test_sample_with_an_unknown_name_is_404(client):
    r = client.post("/api/sources/sample", json={"name": "nope"})
    assert r.status_code == 404 and "nope" in r.json()["detail"]


def test_sample_starts_the_warm_up_once_without_waiting(client, monkeypatch):
    release = threading.Event()
    calls: list[str] = []

    def slow_warm() -> None:
        calls.append(threading.current_thread().name)
        release.wait(5)

    monkeypatch.setattr(warmup, "_warm", slow_warm)
    try:
        # Both responses arrive while the warm-up is still blocked.
        assert client.post("/api/sources/sample").status_code == 200
        assert client.post("/api/sources/sample").status_code == 200
        assert warmup._thread.is_alive()
    finally:
        release.set()
    warmup._thread.join(5)
    assert len(calls) == 1
    assert calls[0] != threading.current_thread().name


def test_a_failing_warm_up_is_logged_not_raised(client, monkeypatch, caplog):
    def boom() -> None:
        raise RuntimeError("no model")

    monkeypatch.setattr(warmup, "_warm", boom)
    assert client.post("/api/sources/sample").status_code == 200
    warmup._thread.join(5)
    assert "no model" in caplog.text


# --- file names (part 4, PR D fixes) -----------------------------------------


def test_a_name_ending_in_part_is_refused(client, dirs):
    from tests.api.conftest import build_pdf, SAMPLE_PAGES

    r = client.post("/api/v2/documents", files={"file": ("r.part", build_pdf(SAMPLE_PAGES), "application/pdf")})
    assert r.status_code == 400
    assert r.json()["detail"] == "A file name ending in .part cannot be uploaded; rename it and try again."
    assert not list(dirs["sources"].glob("*.part"))


# --- the same bytes are stored once, whatever their name ------------------------------


def test_a_samples_bytes_under_new_names_store_no_new_file(client, dirs, monkeypatch):
    from api import sample_set

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    client.get("/api/settings/app")
    sample = sample_set.default_sample()
    before = sorted(p.name for p in dirs["sources"].iterdir() if p.is_file())
    for name in ("s.a", "s.b", "s.c"):
        r = client.post("/api/v2/documents", files={"file": (name, sample.pdf.read_bytes(), "application/pdf")})
        assert r.status_code == 200 and r.json()["sha"] == sample.sha
    assert sorted(p.name for p in dirs["sources"].iterdir() if p.is_file()) == before


def test_your_own_reupload_under_another_name_stores_no_second_copy(client, dirs, monkeypatch):
    from tests.api.test_demo import _pdf_with_pages

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    client.get("/api/settings/app")
    data = _pdf_with_pages(1)
    sha = client.post("/api/v2/documents", files={"file": ("mine.pdf", data, "application/pdf")}).json()["sha"]
    assert client.post("/api/v2/documents", files={"file": ("mine-again.bin", data, "application/pdf")}).status_code == 200
    assert [p.name for p in dirs["sources"].glob(f"{sha}*") if p.is_file()] == [f"{sha}.pdf"]
