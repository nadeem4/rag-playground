"""POST, GET and DELETE /documents, and the Policy's say over them."""

import hashlib
import json

import pytest
from fastapi import HTTPException

from apihelpers import make_client, upload
from pandion_api import Policy
from pandion_api.documents import SHA, DocumentStore
from pdfs import SAMPLE_PAGES, build_pdf

NEWLINE = chr(10)


def test_an_upload_is_kept_by_its_fingerprint(client, tmp_path):
    data = build_pdf(SAMPLE_PAGES)
    body = upload(client, "Report.PDF", data)
    assert body == {
        "sha": hashlib.sha256(data).hexdigest(),
        "filename": "Report.PDF",
        "size": len(data),
        "content_type": "application/pdf",
    }
    assert (tmp_path / "data" / "sources" / f"{body['sha']}.PDF").read_bytes() == data


def test_the_same_bytes_twice_are_one_document(client):
    assert upload(client) == upload(client)
    assert len(client.get("/documents").json()) == 1


def test_an_empty_upload_is_400(client):
    r = client.post("/documents", files={"file": ("e.pdf", b"", "application/pdf")})
    assert r.status_code == 400


def test_the_list_is_by_name_and_never_cached(client):
    upload(client, "b.pdf", build_pdf([["Bee."]]))
    upload(client, "A.pdf", build_pdf([["Ay."]]))
    r = client.get("/documents")
    assert [d["filename"] for d in r.json()] == ["A.pdf", "b.pdf"]
    assert r.headers["cache-control"] == "private, no-store"


def test_delete_removes_the_file_its_record_and_its_question_set(client, tmp_path):
    sha = upload(client)["sha"]
    sources = tmp_path / "data" / "sources"
    (sources / "questions").mkdir()
    (sources / "questions" / f"{sha}.json").write_text("{}", encoding="utf-8")
    assert client.delete(f"/documents/{sha}").json() == {"sha": sha, "deleted": True}
    assert client.get("/documents").json() == []
    assert not [p for p in sources.glob(f"{sha}*") if p.is_file()]
    assert not (sources / "questions" / f"{sha}.json").exists()


@pytest.mark.parametrize("sha", ["nope", "0" * 64])
def test_deleting_what_is_not_there_is_404(client, sha):
    assert client.delete(f"/documents/{sha}").status_code == 404


def test_extra_record_keys_survive_a_second_upload_and_stay_hidden(client, tmp_path):
    sha = upload(client)["sha"]
    sidecar = tmp_path / "data" / "sources" / ".meta" / f"{sha}.json"
    sidecar.write_text(json.dumps({**json.loads(sidecar.read_text()), "secret": 1}), encoding="utf-8")
    upload(client)
    assert json.loads(sidecar.read_text())["secret"] == 1
    assert "secret" not in client.get("/documents").json()[0]


class Owners(Policy):
    """Each upload belongs to the X-User header that sent it."""

    def __init__(self, folder):
        self.store = DocumentStore(folder)

    async def check_upload(self, file, request):
        if not request.headers.get("x-user"):
            raise HTTPException(400, "Say who you are.")
        return await file.read()

    def on_uploaded(self, document, request):
        sidecar = self.store.sidecar(document.sha)
        body = json.loads(sidecar.read_text(encoding="utf-8"))
        sidecar.write_text(json.dumps({**body, "owner": request.headers["x-user"]}), encoding="utf-8")

    def can_read(self, sha, request):
        document = self.store.get(sha)
        return document is not None and document.extra.get("owner") == request.headers.get("x-user")

    def on_delete(self, sha, document, request):
        if document is None or document.extra.get("owner") != request.headers.get("x-user"):
            raise HTTPException(404, "Not yours.")
        return True

    def describe(self, document, request):
        return {"owner": document.extra["owner"]}


def test_a_policy_decides_who_uploads_reads_and_deletes(tmp_path):
    with make_client(tmp_path, Owners(tmp_path / "data" / "sources")) as c:
        assert c.post("/documents", files={"file": ("r.pdf", build_pdf(SAMPLE_PAGES), "application/pdf")}).status_code == 400
        body = upload(c, headers={"X-User": "ann"})
        assert c.get("/documents", headers={"X-User": "ann"}).json() == [{**body, "owner": "ann"}]
        assert c.get("/documents", headers={"X-User": "bob"}).json() == []
        assert c.delete(f"/documents/{body['sha']}", headers={"X-User": "bob"}).status_code == 404
        assert c.delete(f"/documents/{body['sha']}", headers={"X-User": "ann"}).json()["deleted"] is True


def test_on_delete_can_keep_the_file(tmp_path):
    class Keep(Policy):
        def on_delete(self, sha, document, request):
            return False

    with make_client(tmp_path, Keep()) as c:
        sha = upload(c)["sha"]
        assert c.delete(f"/documents/{sha}").json() == {"sha": sha, "deleted": False}
        assert len(c.get("/documents").json()) == 1


@pytest.mark.parametrize(
    ("name", "stored"),
    [
        ("../../outside.pdf", ".pdf"),
        (r"..\..\outside.pdf", ".pdf"),
        ("report.pdf:stream", ""),
        ("report.p df", ""),
        ("noext", ""),
    ],
)
def test_a_file_name_never_chooses_where_the_file_goes(client, tmp_path, name, stored):
    data = build_pdf(SAMPLE_PAGES)
    sha = upload(client, name, data)["sha"]
    sources = tmp_path / "data" / "sources"
    assert [p.name for p in sources.iterdir() if p.is_file()] == [f"{sha}{stored}"]
    assert [p for p in tmp_path.rglob("*") if p.is_file() and "outside" in p.name] == []


def test_the_same_bytes_under_another_name_are_never_stored_twice(client, tmp_path):
    data = build_pdf(SAMPLE_PAGES)
    sha = upload(client, "r.pdf", data)["sha"]
    upload(client, "r.bin", data)
    upload(client, "r", data)
    sources = tmp_path / "data" / "sources"
    assert [p.name for p in sources.iterdir() if p.is_file()] == [f"{sha}.pdf"]


@pytest.mark.parametrize("name", ["r.part", "R.PART"])
def test_a_name_ending_in_part_is_refused(client, tmp_path, name):
    r = client.post("/documents", files={"file": (name, build_pdf(SAMPLE_PAGES), "application/pdf")})
    assert r.status_code == 400
    assert r.json()["detail"] == "A file name ending in .part cannot be uploaded; rename it and try again."
    assert not (tmp_path / "data" / "sources").exists() or not any((tmp_path / "data" / "sources").iterdir())


def test_a_document_id_is_exactly_64_hex_characters():
    good = "a" * 64
    assert SHA.match(good)
    for bad in (good + NEWLINE, good + "0", good[:-1], good.upper(), NEWLINE + good):
        assert not SHA.match(bad)
    assert DocumentStore("x").file(good + NEWLINE) is None
