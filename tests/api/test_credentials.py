"""I-8: the Anthropic key is resolved per run request and never leaks.

The key used everywhere here is fake. The leak tests run a real graph through
the API with that key in the header, then read back every byte the run could
have left anywhere a user or a file could see it, and assert the key is absent.
"""

from __future__ import annotations

import json
from pathlib import Path

import anthropic
import httpx
import pytest
from pydantic import BaseModel

from api import credentials
from core.artifacts import ArtifactType
from core.ports import PortSpec, Stage
from core.registry import Registry
from core.transform import Transform
from tests.api.conftest import make_client

FAKE_KEY = "sk-ant-test-DO-NOT-LEAK-0123456789"
ENV_KEY = "sk-ant-test-ENV-0123456789"
DOTENV_KEY = "sk-ant-test-DOTENV-0123456789"
HEADER = {"X-Anthropic-Api-Key": FAKE_KEY}


# ---------------------------------------------------------------------------
# the resolver
# ---------------------------------------------------------------------------


def write_dotenv(path: Path, value: str) -> None:
    path.write_text(f"# test\nANTHROPIC_API_KEY={value}\n", encoding="utf-8")


def test_header_wins_over_env_and_dotenv(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert credentials.resolve_key(FAKE_KEY) == (FAKE_KEY, "header")


def test_env_wins_over_dotenv(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert credentials.resolve_key(None) == (ENV_KEY, "env")


def test_dotenv_is_the_last_resort_and_is_not_written_to_os_environ(monkeypatch):
    import os

    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert credentials.resolve_key(None) == (DOTENV_KEY, "dotenv")
    assert "ANTHROPIC_API_KEY" not in os.environ


def test_nothing_resolves_to_none():
    assert credentials.resolve_key(None) == (None, "none")


def test_blank_values_count_as_absent(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "  ")
    write_dotenv(credentials.DOTENV_PATH, "")
    assert credentials.resolve_key("   ") == (None, "none")


def test_server_source_ignores_the_header(monkeypatch):
    assert credentials.server_source() == "none"
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert credentials.server_source() == "dotenv"
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    assert credentials.server_source() == "env"


def test_redact_walks_nested_values():
    e = {"error": f"bad {FAKE_KEY}!", "list": [FAKE_KEY, 3], "n": None}
    assert credentials.redact(e, FAKE_KEY) == {
        "error": "bad [redacted]!",
        "list": ["[redacted]", 3],
        "n": None,
    }
    assert credentials.redact(e, None) == e


def test_env_example_is_a_template_with_no_value():
    text = (credentials.REPO_ROOT / ".env.example").read_text(encoding="utf-8")
    assert "ANTHROPIC_API_KEY=\n" in text or text.rstrip().endswith("ANTHROPIC_API_KEY=")
    assert "sk-ant" not in text


# ---------------------------------------------------------------------------
# a stub registry whose transforms read the credential
# ---------------------------------------------------------------------------


class Cfg(BaseModel):
    tag: str = "a"


SEEN: list[dict] = []


def keyed_registry() -> Registry:
    SEEN.clear()
    r = Registry()

    class Src(Transform[Cfg]):
        summary = "A test transform."
        name = "keyed"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            SEEN.append(dict(ctx.extras))
            key = ctx.extras.get("credentials", {}).get("anthropic_api_key")
            ctx.extras["meta"] = {"has_key": key is not None}
            return {"tag": config.tag, "has_key": key is not None}

    class Parse(Transform[Cfg]):
        summary = "A test transform."
        name = "p"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            SEEN.append(dict(ctx.extras))
            return {"from": inputs["file"]["tag"], "tag": config.tag}

    class Boom(Transform[Cfg]):
        summary = "A test transform."
        name = "boom"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            key = ctx.extras["credentials"]["anthropic_api_key"]
            raise RuntimeError(f"the API rejected key {key} (x-api-key: {key})")

    for cls in (Src, Parse, Boom):
        r.register(cls)
    return r


def keyed_graph(parse: str = "p") -> dict:
    return {
        "nodes": [
            {"id": "s", "stage": "source", "transform": "keyed", "config": {}},
            {"id": "x", "stage": "parse", "transform": parse, "config": {}},
        ],
        "edges": [{"src": "s", "dst": "x", "port": "file"}],
    }


@pytest.fixture
def kclient(dirs):
    with make_client(dirs, keyed_registry()) as c:
        yield c


def raw_stream(client, run_id: str) -> str:
    with client.stream("GET", f"/api/runs/{run_id}/events") as r:
        return "".join(r.iter_text())


def events_of(text: str) -> list[dict]:
    return [json.loads(ln[6:]) for ln in text.splitlines() if ln.startswith("data: ")]


def all_file_bytes(root: Path) -> bytes:
    return b"".join(p.read_bytes() for p in root.rglob("*") if p.is_file())


# ---------------------------------------------------------------------------
# the key reaches the transform only when it resolves
# ---------------------------------------------------------------------------


def test_header_key_reaches_the_transform(kclient):
    r = kclient.post("/api/runs", json={"graph": keyed_graph()}, headers=HEADER)
    events_of(raw_stream(kclient, r.json()["run_id"]))
    assert SEEN and all(
        s["credentials"] == {"anthropic_api_key": FAKE_KEY} for s in SEEN
    )


def test_env_key_reaches_the_transform(kclient, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    r = kclient.post("/api/runs", json={"graph": keyed_graph()})
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN[0]["credentials"] == {"anthropic_api_key": ENV_KEY}


def test_dotenv_key_reaches_the_transform(kclient):
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    r = kclient.post("/api/runs", json={"graph": keyed_graph()})
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN[0]["credentials"] == {"anthropic_api_key": DOTENV_KEY}


def test_no_key_means_no_credentials_entry(kclient):
    r = kclient.post("/api/runs", json={"graph": keyed_graph()})
    raw_stream(kclient, r.json()["run_id"])
    assert SEEN and all("credentials" not in s for s in SEEN)


def test_sweep_passes_the_header_key(kclient):
    r = kclient.post(
        "/api/sweeps",
        json={
            "graph": keyed_graph(),
            "node_id": "x",
            "variants": [
                {"transform": "p", "config": {"tag": "1"}},
                {"transform": "p", "config": {"tag": "2"}},
            ],
        },
        headers=HEADER,
    )
    assert r.status_code == 202, r.text
    raw_stream(kclient, r.json()["run_id"])
    assert len(SEEN) == 3
    assert all(s["credentials"]["anthropic_api_key"] == FAKE_KEY for s in SEEN)


# ---------------------------------------------------------------------------
# the leak tests
# ---------------------------------------------------------------------------


def assert_no_leak(client, run_id: str, tmp_path: Path, stream: str) -> None:
    key = FAKE_KEY.encode()
    # 1. the SSE stream, byte for byte
    assert FAKE_KEY not in stream
    # 2. the run snapshot
    assert FAKE_KEY not in client.get(f"/api/runs/{run_id}").text
    # 3. every artifact's meta and payload endpoint
    ids = {e["artifact_id"] for e in events_of(stream) if "artifact_id" in e}
    for aid in ids:
        for url in (f"/api/artifacts/{aid}", f"/api/artifacts/{aid}/payload"):
            r = client.get(url)
            assert FAKE_KEY not in r.text, url
    # 4. the settings endpoints
    assert FAKE_KEY not in client.get("/api/settings/llm").text
    # 5. every file anywhere under the test's temp root: artifact store,
    #    sources, scratch, and any runs/ directory
    assert key not in all_file_bytes(tmp_path)
    # 6. the in-memory run state that outlives the run
    state = client.app.state.runs.get(run_id)
    assert FAKE_KEY not in repr(vars(state))


def test_leak_successful_run(kclient, tmp_path):
    r = kclient.post("/api/runs", json={"graph": keyed_graph()}, headers=HEADER)
    run_id = r.json()["run_id"]
    assert FAKE_KEY not in r.text
    stream = raw_stream(kclient, run_id)
    evs = events_of(stream)
    assert evs[-1]["event"] == "stream_end" and evs[-1]["ok"] is True
    # the transform did see it
    assert SEEN[0]["credentials"]["anthropic_api_key"] == FAKE_KEY
    ids = [e["artifact_id"] for e in evs if e["event"] == "node_finished"]
    assert len(ids) == 2
    assert kclient.get(f"/api/artifacts/{ids[0]}").json()["meta"]["has_key"] is True
    assert_no_leak(kclient, run_id, tmp_path, stream)


def test_leak_sweep(kclient, tmp_path):
    r = kclient.post(
        "/api/sweeps",
        json={
            "graph": keyed_graph(),
            "node_id": "x",
            "variants": [{"transform": "p"}, {"transform": "boom"}],
        },
        headers=HEADER,
    )
    run_id = r.json()["run_id"]
    stream = raw_stream(kclient, run_id)
    assert_no_leak(kclient, run_id, tmp_path, stream)


def test_leak_key_in_an_exception_is_redacted(kclient, tmp_path):
    r = kclient.post("/api/runs", json={"graph": keyed_graph("boom")}, headers=HEADER)
    run_id = r.json()["run_id"]
    stream = raw_stream(kclient, run_id)
    failed = [e for e in events_of(stream) if e["event"] == "node_failed"]
    assert len(failed) == 1
    assert "Traceback" in failed[0]["error"]
    assert "the API rejected key [redacted] (x-api-key: [redacted])" in failed[0]["error"]
    assert_no_leak(kclient, run_id, tmp_path, stream)


def test_leak_run_error_is_redacted(kclient, tmp_path, monkeypatch):
    # The executor itself raising (a crash, not a node failure) takes the
    # manager's run_error path; the key must not survive it either.
    def crash(*args, context_extras=None, **kwargs):
        raise RuntimeError(f"crashed with {context_extras['credentials']}")

    monkeypatch.setattr("api.routes.runs.run", crash)
    r = kclient.post("/api/runs", json={"graph": keyed_graph()}, headers=HEADER)
    run_id = r.json()["run_id"]
    stream = raw_stream(kclient, run_id)
    err = next(e for e in events_of(stream) if e["event"] == "run_error")
    assert "[redacted]" in err["error"]
    assert_no_leak(kclient, run_id, tmp_path, stream)


# ---------------------------------------------------------------------------
# /api/settings/llm
# ---------------------------------------------------------------------------


class FakeModels:
    def __init__(self, exc):
        self.exc = exc

    def list(self):
        if self.exc:
            raise self.exc
        return []


def fake_anthropic(monkeypatch, exc=None) -> list[dict]:
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, **kwargs):
            calls.append(kwargs)
            self.models = FakeModels(exc)

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    return calls


def auth_error(message: str) -> anthropic.AuthenticationError:
    req = httpx.Request("GET", "https://api.anthropic.com/v1/models")
    return anthropic.AuthenticationError(
        message, response=httpx.Response(401, request=req), body=None
    )


def test_settings_reports_server_source_only(client, monkeypatch):
    # I-18: one source per provider; the Anthropic one is checked here.
    assert client.get("/api/settings/llm").json()["anthropic"] == "none"
    # a header is not a server source
    assert client.get("/api/settings/llm", headers=HEADER).json()["anthropic"] == "none"
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert client.get("/api/settings/llm").json()["anthropic"] == "dotenv"
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    r = client.get("/api/settings/llm")
    assert r.json()["anthropic"] == "env"
    assert ENV_KEY not in r.text


def test_check_ok_with_header(client, monkeypatch):
    calls = fake_anthropic(monkeypatch)
    r = client.post("/api/settings/llm/check", headers=HEADER)
    assert r.json() == {"ok": True, "source": "header", "error": None}
    assert calls[0]["api_key"] == FAKE_KEY
    assert FAKE_KEY not in r.text


def test_check_ok_with_env(client, monkeypatch):
    calls = fake_anthropic(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    r = client.post("/api/settings/llm/check")
    assert r.json() == {"ok": True, "source": "env", "error": None}
    assert calls[0]["api_key"] == ENV_KEY


def test_check_with_no_key(client, monkeypatch):
    calls = fake_anthropic(monkeypatch)
    body = client.post("/api/settings/llm/check").json()
    assert body["ok"] is False and body["source"] == "none"
    assert body["error"]
    assert calls == []  # no client built, no network


def test_check_auth_failure_is_readable_and_redacted(client, monkeypatch):
    fake_anthropic(monkeypatch, auth_error(f"invalid x-api-key {FAKE_KEY}"))
    r = client.post("/api/settings/llm/check", headers=HEADER)
    body = r.json()
    assert body["ok"] is False and body["source"] == "header"
    assert "rejected" in body["error"].lower()
    assert FAKE_KEY not in r.text


def test_check_other_failure_is_redacted(client, monkeypatch):
    fake_anthropic(monkeypatch, RuntimeError(f"boom {FAKE_KEY}"))
    r = client.post("/api/settings/llm/check", headers=HEADER)
    body = r.json()
    assert body["ok"] is False and "[redacted]" in body["error"]
    assert FAKE_KEY not in r.text
