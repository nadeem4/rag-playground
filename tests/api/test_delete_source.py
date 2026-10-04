"""Deleting an upload now (`DELETE /api/sources/{sha}`), and the upload time the list gives.

On the demo a visitor deletes only their own upload: another visitor's file,
a sample, or a sha nobody uploaded is refused. A file two visitors uploaded
stays for the other one. Running locally, any upload that is not a sample can
be deleted, since the machine is the owner's own.
"""

from __future__ import annotations

from datetime import datetime, timezone

from api import sample_set
from tests.api.conftest import make_client, upload_pdf

SAMPLE_SHA = sample_set.default_sample().sha


def demo_on(monkeypatch) -> None:
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")


def files_for(sources, sha: str) -> list[str]:
    return sorted(p.name for p in sources.glob(f"{sha}*") if p.is_file())


# --- the upload time in the list -------------------------------------------------


def test_the_list_gives_each_upload_its_upload_time(client):
    before = datetime.now(timezone.utc).replace(microsecond=0)
    body = upload_pdf(client)
    [listed] = client.get("/api/sources").json()
    assert {k: v for k, v in listed.items() if k != "uploaded_at"} == body
    stamp = datetime.fromisoformat(listed["uploaded_at"])
    assert before <= stamp <= datetime.now(timezone.utc)


def test_a_sample_in_the_list_has_no_upload_time(client):
    client.post("/api/sources/sample")
    [listed] = client.get("/api/sources").json()
    assert "uploaded_at" not in listed


def test_the_list_never_shows_the_visitor_ids(client):
    upload_pdf(client)
    [listed] = client.get("/api/sources").json()
    assert "visitors" not in listed


# --- DELETE on the demo ----------------------------------------------------------


def test_demo_deletes_your_own_upload_and_its_record(client, dirs, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    sha = upload_pdf(client)["sha"]
    r = client.delete(f"/api/sources/{sha}")
    assert r.status_code == 200
    assert r.json() == {"sha": sha, "deleted": True}
    assert files_for(dirs["sources"], sha) == []
    assert not (dirs["sources"] / ".meta" / f"{sha}.json").exists()
    assert client.get("/api/sources").json() == []


def test_demo_refuses_another_visitors_upload(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as owner:
        owner.get("/api/settings/app")
        sha = upload_pdf(owner)["sha"]
    with make_client(dirs) as stranger:
        stranger.get("/api/settings/app")
        assert stranger.delete(f"/api/sources/{sha}").status_code == 404
    assert files_for(dirs["sources"], sha) != []


def test_demo_refuses_without_a_visitor_id(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as owner:
        owner.get("/api/settings/app")
        sha = upload_pdf(owner)["sha"]
    with make_client(dirs) as anon:
        assert anon.delete(f"/api/sources/{sha}").status_code == 400
    assert files_for(dirs["sources"], sha) != []


def test_a_file_two_visitors_uploaded_stays_for_the_other(dirs, monkeypatch):
    demo_on(monkeypatch)
    with make_client(dirs) as a, make_client(dirs) as b:
        a.get("/api/settings/app")
        b.get("/api/settings/app")
        sha = upload_pdf(a)["sha"]
        upload_pdf(b)
        r = a.delete(f"/api/sources/{sha}")
        assert r.status_code == 200 and r.json() == {"sha": sha, "deleted": False}
        assert a.get("/api/sources").json() == []
        assert [s["sha"] for s in b.get("/api/sources").json()] == [sha]
    assert files_for(dirs["sources"], sha) != []


def test_demo_refuses_to_delete_a_sample(client, dirs, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    client.post("/api/sources/sample")
    r = client.delete(f"/api/sources/{SAMPLE_SHA}")
    assert r.status_code == 403
    assert files_for(dirs["sources"], SAMPLE_SHA) != []


def test_a_malformed_sha_is_404(client, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    assert client.delete("/api/sources/not-a-sha").status_code == 404
    assert client.delete("/api/sources/" + "0" * 64).status_code == 404


# --- DELETE running locally ------------------------------------------------------


def test_locally_any_upload_can_be_deleted(dirs):
    with make_client(dirs) as uploader:
        sha = upload_pdf(uploader)["sha"]
    with make_client(dirs) as other_browser:
        r = other_browser.delete(f"/api/sources/{sha}")
        assert r.status_code == 200 and r.json() == {"sha": sha, "deleted": True}
    assert files_for(dirs["sources"], sha) == []


def test_locally_a_sample_is_refused(client, dirs):
    client.post("/api/sources/sample")
    assert client.delete(f"/api/sources/{SAMPLE_SHA}").status_code == 403
    assert files_for(dirs["sources"], SAMPLE_SHA) != []
