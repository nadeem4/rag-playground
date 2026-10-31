"""The playground is a pandion-api app with its own Policy (playground/backend/policy.py)."""

from __future__ import annotations

import pytest

from playground.backend import demo
from playground.backend.deps import build_deps
from playground.backend.main import API_PREFIX, api_settings, create_app
from playground.backend.policy import PlaygroundPolicy


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


def test_a_run_goes_through_the_one_run_manager_and_its_demo_limit(client, monkeypatch):
    from pandion_api.runs import RunManager

    from tests.api.conftest import read_sse, upload_pdf
    from tests.api.test_v2_strategies import PIPELINE

    assert isinstance(client.app.state.runs, RunManager)
    sha = upload_pdf(client)["sha"]
    r = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sha], "through": "chunk"})
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    state = client.app.state.runs.get(run_id)
    assert state is not None and state.kind == "index"
    read_sse(client, run_id, prefix="/api/v2")  # to the run's end, so no worker outlives the test
    assert state.done and state.status == "finished"
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


BUILT_IN_CHECKS = {"file_type", "name", "path", "metadata", "properties", "text_layer", "contains"}


@pytest.fixture
def plugin_check():
    """A route check a plugin registered, removed again after the test."""
    from pandion.routing import CHECKS, route_check

    route_check("is_invoice", summary="Is an invoice.")(lambda info, settings: True)
    yield "is_invoice"
    CHECKS.pop("is_invoice", None)


def test_the_demo_lists_only_the_built_in_checks_even_when_a_plugin_registered_one(client, monkeypatch, plugin_check):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert set(client.get("/api/v2/strategies").json()["stages"]["route"]) == BUILT_IN_CHECKS


def test_a_local_run_lists_plugin_checks(client, plugin_check):
    assert set(client.get("/api/v2/strategies").json()["stages"]["route"]) == BUILT_IN_CHECKS | {plugin_check}


def test_the_demo_still_refuses_a_request_that_sends_plugins(client, monkeypatch):
    from tests.api.test_v2_strategies import PIPELINE

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    r = client.post("/api/v2/pipelines/validate", json={"config": {**PIPELINE, "plugins": ["my_checks"]}})
    assert r.json()["ok"] is False and "cannot load plugins" in r.text
