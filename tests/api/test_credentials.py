"""I-8: the Anthropic key is resolved per run request and never leaks.

The key used everywhere here is fake. That a run on /api/v2 gets the right key
and shows none of it is proven in `test_v2_runs.py` and in pandion-api's own
`test_api_runs.py`.
"""

from __future__ import annotations

from pathlib import Path

import anthropic
import httpx

from api import credentials

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


def test_uvicorn_access_log_records_the_request_line_not_headers():
    """uvicorn's access line is built from five values, none of them a header."""
    import logging
    import re

    from uvicorn.config import LOGGING_CONFIG
    from uvicorn.logging import AccessFormatter

    fmt = LOGGING_CONFIG["formatters"]["access"]["fmt"]
    assert set(re.findall(r"%\((\w+)\)", fmt)) == {
        "levelprefix",
        "client_addr",
        "request_line",
        "status_code",
    }
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        0,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:51000", "POST", "/api/v2/runs", "1.1", 202),
        None,
    )
    line = AccessFormatter(fmt, use_colors=False).formatMessage(record)
    assert "POST /api/v2/runs HTTP/1.1" in line and "202" in line
    assert FAKE_KEY not in line


def test_env_example_is_a_template_with_no_value():
    text = (credentials.REPO_ROOT / ".env.example").read_text(encoding="utf-8")
    assert "ANTHROPIC_API_KEY=\n" in text or text.rstrip().endswith("ANTHROPIC_API_KEY=")
    assert "sk-ant" not in text


# ---------------------------------------------------------------------------
# a run is given the key from a header only
# ---------------------------------------------------------------------------


def test_a_key_in_the_query_string_is_not_read(client, monkeypatch):
    """The key travels in a header only. A query string is read by proxies and
    kept in browser history, so the server must ignore one that holds a key."""
    from types import SimpleNamespace

    from pandion import IndexPipeline
    from tests.api.conftest import read_sse, upload_pdf
    from tests.api.test_v2_strategies import PIPELINE

    seen: list = []

    def spy_run(self, documents, *, credentials=None, **kwargs):
        seen.append(credentials)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", spy_run)
    sha = upload_pdf(client)["sha"]
    r = client.post(
        f"/api/v2/runs?x_anthropic_api_key={FAKE_KEY}&api_key={FAKE_KEY}",
        json={"config": PIPELINE, "documents": [sha]},
    )
    assert r.status_code == 202, r.text
    read_sse(client, r.json()["run_id"], prefix="/api/v2")
    assert seen == [None]


# ---------------------------------------------------------------------------
# /api/v2/settings/models
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
    assert client.get("/api/v2/settings/models").json()["anthropic"] == "none"
    # a header is not a server source
    assert client.get("/api/v2/settings/models", headers=HEADER).json()["anthropic"] == "none"
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    assert client.get("/api/v2/settings/models").json()["anthropic"] == "dotenv"
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    r = client.get("/api/v2/settings/models")
    assert r.json()["anthropic"] == "env"
    assert ENV_KEY not in r.text


def test_check_ok_with_header(client, monkeypatch):
    calls = fake_anthropic(monkeypatch)
    r = client.post("/api/v2/settings/models/check", headers=HEADER)
    assert r.json() == {"ok": True, "source": "header", "error": None}
    assert calls[0]["api_key"] == FAKE_KEY
    assert FAKE_KEY not in r.text


def test_check_ok_with_env(client, monkeypatch):
    calls = fake_anthropic(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    r = client.post("/api/v2/settings/models/check")
    assert r.json() == {"ok": True, "source": "env", "error": None}
    assert calls[0]["api_key"] == ENV_KEY


def test_check_with_no_key(client, monkeypatch):
    calls = fake_anthropic(monkeypatch)
    body = client.post("/api/v2/settings/models/check").json()
    assert body["ok"] is False and body["source"] == "none"
    assert body["error"]
    assert calls == []  # no client built, no network


def test_check_auth_failure_is_readable_and_redacted(client, monkeypatch):
    fake_anthropic(monkeypatch, auth_error(f"invalid x-api-key {FAKE_KEY}"))
    r = client.post("/api/v2/settings/models/check", headers=HEADER)
    body = r.json()
    assert body["ok"] is False and body["source"] == "header"
    assert "rejected" in body["error"].lower()
    assert FAKE_KEY not in r.text


def test_check_other_failure_is_redacted(client, monkeypatch):
    fake_anthropic(monkeypatch, RuntimeError(f"boom {FAKE_KEY}"))
    r = client.post("/api/v2/settings/models/check", headers=HEADER)
    body = r.json()
    assert body["ok"] is False and "[redacted]" in body["error"]
    assert FAKE_KEY not in r.text
