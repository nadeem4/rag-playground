"""`rag-playground` CLI: host and port from flags or environment, and when to open a browser."""

from __future__ import annotations

import pytest

from api import cli


@pytest.fixture
def launched(monkeypatch) -> dict:
    """Capture what the CLI would start instead of starting it."""
    seen: dict = {"browser": []}

    def fake_run(app, host, port, reload):
        seen.update(app=app, host=host, port=port, reload=reload)

    class FakeTimer:
        def __init__(self, delay, fn, args=()):
            self.args = args

        def start(self):
            seen["browser"].append(self.args[0])

    monkeypatch.setattr(cli.uvicorn, "run", fake_run)
    monkeypatch.setattr(cli.threading, "Timer", FakeTimer)
    monkeypatch.delenv("RAG_PLAYGROUND_HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    return seen


def test_defaults_to_loopback_port_8000_and_opens_browser(launched):
    cli.main([])
    assert launched["host"] == "127.0.0.1"
    assert launched["port"] == 8000
    assert launched["browser"] == ["http://127.0.0.1:8000/"]


def test_host_flag(launched):
    cli.main(["--host", "0.0.0.0", "--no-browser"])
    assert launched["host"] == "0.0.0.0"


def test_host_from_env_when_flag_absent(launched, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_HOST", "0.0.0.0")
    cli.main(["--no-browser"])
    assert launched["host"] == "0.0.0.0"


def test_host_flag_beats_env(launched, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_HOST", "0.0.0.0")
    cli.main(["--host", "127.0.0.1", "--no-browser"])
    assert launched["host"] == "127.0.0.1"


def test_port_from_env_when_flag_absent(launched, monkeypatch):
    monkeypatch.setenv("PORT", "7860")
    cli.main(["--no-browser"])
    assert launched["port"] == 7860


def test_port_flag_beats_env(launched, monkeypatch):
    monkeypatch.setenv("PORT", "7860")
    cli.main(["--port", "8080", "--no-browser"])
    assert launched["port"] == 8080


def test_no_browser_when_host_is_not_loopback(launched):
    cli.main(["--host", "0.0.0.0"])
    assert launched["browser"] == []


def test_browser_for_localhost(launched):
    cli.main(["--host", "localhost", "--port", "8123"])
    assert launched["browser"] == ["http://localhost:8123/"]
