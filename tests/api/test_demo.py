"""Demo mode (`RAG_PLAYGROUND_DEMO=1`): a public host shared by strangers.

No uploads, only the bundled sample is visible or readable, and the Anthropic
key comes only from the request header, never from the host's env or `.env`.
"""

from __future__ import annotations

import hashlib

import pytest

from api import credentials
from api.routes import sources as sources_route
from tests.api.conftest import ingest_graph, make_client, read_sse, upload_pdf
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

SAMPLE_SHA = hashlib.sha256(sources_route.SAMPLE_PDF.read_bytes()).hexdigest()


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
    assert client.get("/api/settings/app").json() == {"demo": True}


# --- sources ------------------------------------------------------------------


def test_upload_is_refused(client, dirs, monkeypatch):
    demo_on(monkeypatch)
    r = client.post("/api/sources", files={"file": ("a.pdf", b"%PDF-1", "application/pdf")})
    assert r.status_code == 403
    assert "demo" in r.json()["detail"].lower()
    assert not dirs["sources"].exists()


def test_list_shows_only_the_sample(client, monkeypatch):
    upload_pdf(client, "someone-elses.pdf")  # e.g. left over from before demo mode
    demo_on(monkeypatch)
    assert client.get("/api/sources").json() == []
    body = client.post("/api/sources/sample").json()
    assert body["sha"] == SAMPLE_SHA
    assert client.get("/api/sources").json() == [body]


def test_pages_serve_only_the_sample(client, monkeypatch):
    other = upload_pdf(client)["sha"]
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


def test_runs_and_sweeps_read_only_the_sample(client, monkeypatch):
    other = upload_pdf(client)
    demo_on(monkeypatch)
    graph = ingest_graph(other["sha"], other["filename"])
    assert client.post("/api/runs", json={"graph": graph}).status_code == 403
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
