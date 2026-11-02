"""Serve exposes no lab routes, docs, versions or CORS unless asked."""

import pytest

from apihelpers import make_serve_client
from pandion_api import ServeSettings
from pandion_api.app import ROUTERS
from pandion_api.serve import SERVE_ROUTERS

ORIGIN = {"Origin": "https://site.example"}


def paths(routers):
    return {route.path for router in routers for route in router.routes}


def test_every_lab_route_is_a_404_in_serve(tmp_path):
    lab_only = paths(ROUTERS) - paths(SERVE_ROUTERS)
    assert lab_only
    with make_serve_client(tmp_path) as c:
        for path in sorted(lab_only):
            url = path.replace("{", "").replace("}", "")
            for method in ("get", "post", "delete"):
                assert getattr(c, method)(url).status_code == 404, (method, path)


def test_health_shows_no_version_and_ready_no_reason(tmp_path):
    with make_serve_client(tmp_path, indexed=False) as c:
        assert c.get("/health").json() == {"status": "ok"}
        assert c.get("/ready").json() == {"ready": False}


def test_docs_and_openapi_are_off_in_serve(tmp_path):
    with make_serve_client(tmp_path) as c:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert c.get(path).status_code == 404, path


def test_cors_is_off_by_default(tmp_path):
    with make_serve_client(tmp_path) as c:
        assert "access-control-allow-origin" not in c.get("/health", headers=ORIGIN).headers


def test_an_allowlisted_origin_gets_cors(tmp_path):
    with make_serve_client(tmp_path, serve=ServeSettings(cors_origins=("https://site.example",))) as c:
        assert c.get("/health", headers=ORIGIN).headers["access-control-allow-origin"] == "https://site.example"
        assert "access-control-allow-origin" not in c.get("/health", headers={"Origin": "https://evil.example"}).headers


def test_a_wildcard_origin_is_refused(tmp_path):
    with pytest.raises(ValueError, match="cors_origins"):
        make_serve_client(tmp_path, serve=ServeSettings(cors_origins=("*",)))
