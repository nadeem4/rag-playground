"""Demo mode (`RAG_PLAYGROUND_DEMO=1`): a public host shared by strangers.

Uploads are allowed but private to the browser that made them; the bundled
samples stay visible and readable to everyone. The Anthropic key comes only
from the request header, never from the host's env or `.env`.
"""

from __future__ import annotations

import pytest

from api import credentials, sample_set
from tests.api.conftest import build_pdf, ingest_graph, make_client, read_sse, upload_pdf
from tests.api.test_credentials import (
    DOTENV_KEY,
    ENV_KEY,
    FAKE_KEY,
    HEADER,
    SEEN,
    fake_anthropic,
    keyed_graph,
    keyed_registry,
    raw_stream,
    write_dotenv,
)

SAMPLE_SHA = sample_set.default_sample().sha


def demo_on(monkeypatch) -> None:
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")


# --- /api/settings/app --------------------------------------------------------


def test_app_settings_report_demo_off_by_default(client):
    assert client.get("/api/settings/app").json() == {"demo": False}


@pytest.mark.parametrize("value", ["0", "", "true"])
def test_only_1_turns_demo_on(client, monkeypatch, value):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", value)
    assert client.get("/api/settings/app").json() == {"demo": False}


def test_app_settings_report_demo_on(client, monkeypatch):
    demo_on(monkeypatch)
    assert client.get("/api/settings/app").json()["demo"] is True


# --- sources ------------------------------------------------------------------


def test_list_shows_the_samples_and_only_your_own_uploads(dirs, monkeypatch):
    with make_client(dirs) as someone_else:
        upload_pdf(someone_else, "someone-elses.pdf")
    demo_on(monkeypatch)
    with make_client(dirs) as me:
        assert me.get("/api/sources").json() == []
        body = me.post("/api/sources/sample").json()
        assert body["sha"] == SAMPLE_SHA
        assert me.get("/api/sources").json() == [body]


@pytest.mark.parametrize("name", [s.name for s in sample_set.all_samples()])
def test_every_sample_is_readable_in_demo_mode(client, monkeypatch, name):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    sha = client.post("/api/sources/sample", json={"name": name}).json()["sha"]
    listed = {s["sha"] for s in client.get("/api/sources").json()}
    assert sha in listed
    # The real pages route (api/routes/pages.py), not just the source listing.
    assert client.get(f"/api/sources/{sha}/pages/1.png").status_code == 200


def test_pages_serve_only_the_sample(client, dirs, monkeypatch):
    with make_client(dirs) as someone_else:
        other = upload_pdf(someone_else)["sha"]
    demo_on(monkeypatch)
    client.post("/api/sources/sample")
    assert client.get(f"/api/sources/{SAMPLE_SHA}/pages").status_code == 200
    assert client.get(f"/api/sources/{SAMPLE_SHA}/pages/1.png").status_code == 200
    r = client.get(f"/api/sources/{SAMPLE_SHA}/pages/1/find", params={"text": "chunk"})
    assert r.status_code == 200
    assert client.get(f"/api/sources/{other}/pages").status_code == 404
    assert client.get(f"/api/sources/{other}/pages/1.png").status_code == 404
    r = client.get(f"/api/sources/{other}/pages/1/find", params={"text": "x"})
    assert r.status_code == 404


def test_runs_and_sweeps_read_only_the_sample(client, dirs, monkeypatch):
    with make_client(dirs) as someone_else:
        other = upload_pdf(someone_else)
    demo_on(monkeypatch)
    graph = ingest_graph(other["sha"], other["filename"])
    r = client.post("/api/runs", json={"graph": graph})
    assert r.status_code == 403
    assert r.json()["detail"] == (
        "This document is not available to this browser. It may be an upload that has expired, "
        "or one made from another browser. Load a sample or upload the file again."
    )
    # an override cannot swap the sha back in either
    sample = client.post("/api/sources/sample").json()
    ok_graph = ingest_graph(sample["sha"], sample["filename"])
    r = client.post(
        "/api/runs",
        json={"graph": ok_graph, "overrides": {"src": {"sha": other["sha"], "filename": "x.pdf"}}},
    )
    assert r.status_code == 403
    r = client.post(
        "/api/sweeps",
        json={
            "graph": ok_graph,
            "node_id": "src",
            "variants": [{"transform": "upload", "config": {"sha": other["sha"], "filename": "x.pdf"}}],
        },
    )
    assert r.status_code == 403
    # the sample itself runs
    r = client.post("/api/runs", json={"graph": ok_graph})
    assert r.status_code == 202
    events = read_sse(client, r.json()["run_id"])
    assert [e["event"] for e in events][-2:] == ["run_finished", "stream_end"]
    assert not any(e["event"] == "node_failed" for e in events)


def test_outside_demo_any_uploaded_sha_is_served(client):
    sha = upload_pdf(client)["sha"]
    assert client.get(f"/api/sources/{sha}/pages").status_code == 200


# --- the key: header only -----------------------------------------------------


def test_resolver_ignores_env_and_dotenv(monkeypatch):
    demo_on(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert credentials.resolve_key(None) == (None, "none")
    assert credentials.resolve_key("  ") == (None, "none")
    assert credentials.server_source() == "none"
    assert credentials.resolve_key(FAKE_KEY) == (FAKE_KEY, "header")


def test_settings_report_no_server_key(client, monkeypatch):
    demo_on(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert client.get("/api/settings/llm").json()["anthropic"] == "none"


def test_check_never_spends_the_host_key(client, monkeypatch):
    demo_on(monkeypatch)
    calls = fake_anthropic(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    body = client.post("/api/settings/llm/check").json()
    assert body["ok"] is False and body["source"] == "none"
    assert calls == []
    body = client.post("/api/settings/llm/check", headers=HEADER).json()
    assert body == {"ok": True, "source": "header", "error": None}
    assert [c["api_key"] for c in calls] == [FAKE_KEY]


@pytest.fixture
def kclient(dirs):
    with make_client(dirs, keyed_registry()) as c:
        yield c


def test_host_key_never_reaches_a_run(kclient, monkeypatch):
    demo_on(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    r = kclient.post("/api/runs", json={"graph": keyed_graph()})
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN and all("credentials" not in s for s in SEEN)


def test_host_key_never_reaches_a_sweep(kclient, monkeypatch):
    demo_on(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    r = kclient.post(
        "/api/sweeps",
        json={"graph": keyed_graph(), "node_id": "x",
              "variants": [{"transform": "p", "config": {"tag": "1"}}]},
    )
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN and all("credentials" not in s for s in SEEN)


def test_visitor_header_key_still_reaches_a_run(kclient, monkeypatch):
    demo_on(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    r = kclient.post("/api/runs", json={"graph": keyed_graph()}, headers=HEADER)
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN and all(
        s["credentials"] == {"anthropic_api_key": FAKE_KEY} for s in SEEN
    )


# --- custom endpoints: a server-side request to a visitor's URL ----------------


def chat_graph(model: str = "claude-opus-5") -> dict:
    return {
        "nodes": [
            {"id": "chat", "stage": "use_case", "transform": "chat",
             "config": {"model": model, "custom_base_url": "http://169.254.169.254/",
                        "custom_model": "m"}},
        ],
        "edges": [],
    }


def test_a_custom_chat_node_is_refused_in_runs(client, monkeypatch):
    demo_on(monkeypatch)
    r = client.post("/api/runs", json={"graph": chat_graph("custom")})
    assert r.status_code == 403
    assert "custom" in r.json()["detail"].lower()


def test_an_override_cannot_switch_a_chat_node_to_custom(client, monkeypatch):
    demo_on(monkeypatch)
    r = client.post(
        "/api/runs",
        json={"graph": chat_graph(), "overrides": {"chat": {"model": "custom"}}},
    )
    assert r.status_code == 403


def test_a_custom_chat_variant_is_refused_in_sweeps(client, monkeypatch):
    demo_on(monkeypatch)
    r = client.post(
        "/api/sweeps",
        json={"graph": chat_graph(), "node_id": "chat",
              "variants": [{"transform": "chat", "config": {"model": "gpt-6-astra"}},
                           {"transform": "chat", "config": {"model": "custom"}}]},
    )
    assert r.status_code == 403


def test_outside_demo_a_custom_chat_node_is_not_refused(client):
    r = client.post("/api/runs", json={"graph": chat_graph("custom")})
    assert r.status_code != 403  # the one-node graph is invalid for other reasons


# --- upload limits --------------------------------------------------------------


def _pdf_with_pages(n: int) -> bytes:
    return build_pdf([f"Page {i}" for i in range(1, n + 1)])


def test_demo_settings_report_the_limits(client, monkeypatch):
    demo_on(monkeypatch)
    assert client.get("/api/settings/app").json() == {
        "demo": True,
        "limits": {
            "max_bytes": 10 * 1024 * 1024,
            "max_pages": 20,
            "max_files": 3,
            "max_total_bytes": 200 * 1024 * 1024,
            "ttl_hours": 24,
        },
    }
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    assert client.get("/api/settings/app").json() == {"demo": False}


def test_demo_refuses_a_file_over_10_mb(client, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")  # a demo upload needs the visitor cookie first
    big = b"%PDF-1.4\n" + b"0" * (10 * 1024 * 1024)
    r = client.post("/api/sources", files={"file": ("big.pdf", big, "application/pdf")})
    assert r.status_code == 413
    assert r.json()["detail"] == "This file is 10.0 MB. The hosted demo takes files up to 10 MB. Run the playground locally for larger files."


def test_demo_refuses_a_non_pdf(client, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    r = client.post("/api/sources", files={"file": ("notes.txt", b"just text", "text/plain")})
    assert r.status_code == 415
    assert r.json()["detail"] == "The hosted demo takes PDF files only."


def test_demo_refuses_more_than_20_pages(client, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    r = client.post("/api/sources", files={"file": ("long.pdf", _pdf_with_pages(21), "application/pdf")})
    assert r.status_code == 413
    assert r.json()["detail"] == "This PDF has 21 pages. The hosted demo takes up to 20 pages. Run the playground locally for longer documents."
    ok = client.post("/api/sources", files={"file": ("fine.pdf", _pdf_with_pages(20), "application/pdf")})
    assert ok.status_code == 200


def test_demo_caps_live_uploads_per_visitor_and_a_reupload_does_not_count(client, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    for i in range(3):
        assert client.post("/api/sources", files={"file": (f"f{i}.pdf", _pdf_with_pages(i + 1), "application/pdf")}).status_code == 200
    again = client.post("/api/sources", files={"file": ("f0-again.pdf", _pdf_with_pages(1), "application/pdf")})
    assert again.status_code == 200
    r = client.post("/api/sources", files={"file": ("f3.pdf", _pdf_with_pages(4), "application/pdf")})
    assert r.status_code == 429
    assert r.json()["detail"] == "This browser already has 3 uploads. Wait for one to expire, or run the playground locally."


def test_outside_demo_mode_nothing_is_capped(client):
    r = client.post("/api/sources", files={"file": ("long.pdf", _pdf_with_pages(25), "application/pdf")})
    assert r.status_code == 200
    r = client.post("/api/sources", files={"file": ("notes.txt", b"just text", "text/plain")})
    assert r.status_code == 200


def test_demo_upload_tolerates_a_corrupt_sidecar(dirs, monkeypatch):
    demo_on(monkeypatch)
    meta_dir = dirs["sources"] / ".meta"
    meta_dir.mkdir(parents=True)
    (meta_dir / "deadbeef.json").write_text("not json", encoding="utf-8")
    with make_client(dirs) as client:
        client.get("/api/settings/app")
        r = client.post("/api/sources", files={"file": ("small.pdf", _pdf_with_pages(1), "application/pdf")})
        assert r.status_code == 200


# --- the expiry sweeper ---------------------------------------------------------


def test_the_sweeper_runs_only_in_demo_mode(dirs, monkeypatch):
    from api import expiry
    started: list = []
    monkeypatch.setattr(expiry, "run_forever", lambda sources, interval_s=3600: started.append(sources) or _never())
    with make_client(dirs):
        pass
    assert started == []
    demo_on(monkeypatch)
    with make_client(dirs):
        pass
    assert started == [dirs["sources"]]


async def _never():
    import asyncio
    await asyncio.Event().wait()


# --- final review: memory, disk and the samples ---------------------------------


def test_demo_never_reads_more_than_the_cap_plus_one_byte(client, dirs, monkeypatch):
    from starlette.datastructures import UploadFile

    demo_on(monkeypatch)
    client.get("/api/settings/app")
    asked: list[int] = []
    real_read = UploadFile.read

    async def recording_read(self, size: int = -1) -> bytes:
        asked.append(size)
        return await real_read(self, size)

    monkeypatch.setattr(UploadFile, "read", recording_read)
    big = b"%PDF-1.4\n" + b"0" * (10 * 1024 * 1024 - 8)  # the cap plus one byte
    r = client.post("/api/sources", files={"file": ("big.pdf", big, "application/pdf")})
    assert r.status_code == 413
    assert all(0 <= n <= 10 * 1024 * 1024 + 1 for n in asked)
    assert not (dirs["sources"] / ".meta").exists()


def test_the_demo_refuses_uploads_past_its_total_budget(dirs, monkeypatch):
    from api import demo

    demo_on(monkeypatch)
    first, second = _pdf_with_pages(1), _pdf_with_pages(2)
    monkeypatch.setattr(demo, "MAX_TOTAL_UPLOAD_BYTES", len(first) + 1)
    with make_client(dirs) as a, make_client(dirs) as b:
        a.get("/api/settings/app")
        b.get("/api/settings/app")
        sha = a.post("/api/sources", files={"file": ("one.pdf", first, "application/pdf")}).json()["sha"]
        r = b.post("/api/sources", files={"file": ("two.pdf", second, "application/pdf")})
        assert r.status_code == 503
        assert r.json()["detail"] == "The demo is full right now. Try again later, or run the playground locally."
        # the same bytes again add nothing to the disk, so they still fit
        assert b.post("/api/sources", files={"file": ("one.pdf", first, "application/pdf")}).status_code == 200
        assert a.get(f"/api/sources/{sha}/pages/1.png").status_code == 200


def test_demo_limits_report_the_total_budget(client, monkeypatch):
    demo_on(monkeypatch)
    assert client.get("/api/settings/app").json()["limits"]["max_total_bytes"] == 200 * 1024 * 1024


def test_uploading_a_samples_bytes_does_not_count_toward_the_cap(client, monkeypatch):
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    sample = sample_set.default_sample()
    r = client.post("/api/sources", files={"file": (sample.pdf.name, sample.pdf.read_bytes(), "application/pdf")})
    assert r.status_code == 200 and r.json()["sha"] == SAMPLE_SHA
    for i in range(3):
        f = (f"f{i}.pdf", _pdf_with_pages(i + 1), "application/pdf")
        assert client.post("/api/sources", files={"file": f}).status_code == 200
