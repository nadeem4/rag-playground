from __future__ import annotations

import hashlib

from plugins.source import upload
from tests.api.conftest import upload_pdf


def test_upload_is_content_addressed(client, dirs):
    body = upload_pdf(client, "Paper.PDF")
    assert body["filename"] == "Paper.PDF"
    assert body["size"] > 0
    assert body["content_type"] == "application/pdf"
    # upload.py's naming rule: SOURCES_DIR / f"{sha}{Path(filename).suffix}"
    assert (dirs["sources"] / f"{body['sha']}.PDF").is_file()


def test_upload_is_idempotent(client, dirs):
    a = upload_pdf(client)
    b = upload_pdf(client)
    assert a == b
    assert len([p for p in dirs["sources"].iterdir() if p.is_file()]) == 1


def test_empty_upload_is_400(client):
    r = client.post("/api/sources", files={"file": ("e.pdf", b"", "application/pdf")})
    assert r.status_code == 400


def test_uploaded_file_is_findable_by_the_upload_transform(client, dirs):
    body = upload_pdf(client)
    assert upload.SOURCES_DIR == dirs["sources"]
    cls = upload.Upload
    out = cls().apply(
        {}, cls.config_model(sha=body["sha"], filename=body["filename"]), None
    )
    assert out["path"] == str(dirs["sources"] / f"{body['sha']}.pdf")


def test_list_sources(client):
    assert client.get("/api/sources").json() == []
    body = upload_pdf(client)
    listed = client.get("/api/sources").json()
    assert listed == [body]


def test_distinct_bytes_distinct_sha(client):
    a = client.post("/api/sources", files={"file": ("a.txt", b"one", "text/plain")})
    b = client.post("/api/sources", files={"file": ("b.txt", b"two", "text/plain")})
    assert a.json()["sha"] == hashlib.sha256(b"one").hexdigest()
    assert a.json()["sha"] != b.json()["sha"]
