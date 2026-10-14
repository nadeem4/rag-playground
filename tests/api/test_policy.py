"""The playground is a pandion-api app with its own Policy (api/policy.py)."""

from __future__ import annotations

import pytest

from api import demo
from api.deps import build_deps
from api.main import API_PREFIX, api_settings, create_app
from api.policy import PlaygroundPolicy


def test_the_demo_allows_two_runs_at_once_and_a_local_run_has_no_limit(monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert PlaygroundPolicy().max_active_runs() == demo.MAX_ACTIVE_RUNS == 2
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    assert PlaygroundPolicy().max_active_runs() is None


def test_the_app_is_pandion_api_with_the_playground_policy(client):
    assert isinstance(client.app.state.policy, PlaygroundPolicy)
    assert API_PREFIX == "/api/v2"
    assert client.get("/api/v2/health").json()["status"] == "ok"
    assert client.get("/api/health").json()["status"] == "ok"


def test_the_old_routes_and_pandion_api_share_one_run_manager(client, monkeypatch):
    from pandion_api.runs import RunManager

    assert isinstance(client.app.state.runs, RunManager)
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert client.app.state.runs._limit() == 2
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    assert client.app.state.runs._limit() is None


def test_the_data_folder_holds_sources_and_artifacts(dirs):
    deps = build_deps(artifacts_dir=dirs["artifacts"], sources_dir=dirs["sources"], web_dist=dirs["web"])
    s = api_settings(deps)
    assert s.data_dir == dirs["sources"].parent
    assert s.prefix == "/api/v2" and s.models.device == "cpu"


def test_folders_that_are_not_siblings_are_refused_with_a_sentence(tmp_path):
    deps = build_deps(artifacts_dir=tmp_path / "a" / "artifacts", sources_dir=tmp_path / "b" / "sources")
    with pytest.raises(ValueError, match="side by side"):
        create_app(deps)
