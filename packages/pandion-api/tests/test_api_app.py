"""create_app, the settings, the default Policy and GET /health."""

from fastapi import Depends, Request
from fastapi.testclient import TestClient

import pandion
import pandion_api
from apihelpers import settings
from pandion_api import ApiSettings, Policy, create_app


def test_health_names_both_versions(client):
    assert client.get("/health").json() == {
        "status": "ok",
        "pandion": pandion.__version__,
        "pandion_api": pandion_api.__version__,
    }


def test_the_routes_sit_under_the_prefix(tmp_path):
    with TestClient(create_app(settings(tmp_path, prefix="/api/v2"))) as c:
        assert c.get("/api/v2/health").status_code == 200
        assert c.get("/health").status_code == 404


def test_the_policy_starts_and_stops_with_the_app(tmp_path):
    seen: list[str] = []

    class Recording(Policy):
        async def on_startup(self, app):
            seen.append(f"start {app.state.settings.data_dir.name}")

        async def on_shutdown(self, app):
            seen.append("stop")

    with TestClient(create_app(settings(tmp_path), Recording())):
        assert seen == ["start data"]
    assert seen == ["start data", "stop"]


def test_a_policys_dependencies_run_on_every_route(tmp_path):
    calls: list[str] = []

    def note(request: Request) -> None:
        calls.append(request.url.path)

    class Noting(Policy):
        def dependencies(self):
            return [Depends(note)]

    with TestClient(create_app(settings(tmp_path), Noting())) as c:
        c.get("/health")
    assert calls == ["/health"]


def test_the_settings_name_the_sources_folder(tmp_path):
    s = ApiSettings(data_dir=tmp_path)
    assert s.sources == tmp_path / "sources"
    assert s.prefix == "" and s.models == pandion.ModelSettings()


def test_the_public_names():
    assert set(pandion_api.__all__) >= {"ApiSettings", "Policy", "create_app", "__version__"}
