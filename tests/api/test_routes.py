"""Which routes the playground serves once the web is on /api/v2."""

from __future__ import annotations

import re
from pathlib import Path

from playground.backend.deps import build_deps
from playground.backend.main import create_app

ROOT = Path(__file__).resolve().parents[2]

#: The playground's own routes (spec section 1: its teaching routes).
TEACHING = {
    ("GET", "/api/health"),
    ("GET", "/api/samples"),
    ("GET", "/api/samples/questions"),
    ("GET", "/api/samples/{name}/questions"),
    ("POST", "/api/sources/sample"),
    ("GET", "/api/learn/chunking"),
    ("GET", "/api/learn/document"),
    ("GET", "/api/stages"),
    ("GET", "/api/settings/app"),
    ("GET", "/api/questions/template"),
    ("GET", "/api/templates"),
    # Take it home: the pipeline as a project zip, written by pandion.new_project.
    ("POST", "/api/project.zip"),
}


def served(app) -> set[tuple[str, str]]:
    """Every (method, path) the app serves, read from its OpenAPI schema.

    FastAPI 0.141 keeps an included router as one entry in `app.routes`, so the
    schema is the public place that lists every route. Only the SPA's catch-all
    is left out of it, and that serves no /api path."""
    return {(m.upper(), p) for p, ops in app.openapi()["paths"].items() for m in ops}


def app_for(dirs):
    return create_app(build_deps(artifacts_dir=dirs["artifacts"], sources_dir=dirs["sources"], web_dist=dirs["web"]))


def test_under_api_only_the_teaching_routes_and_v2_are_left(dirs):
    app = app_for(dirs)
    own = {(m, p) for m, p in served(app) if p.startswith("/api/") and not p.startswith("/api/v2/") and m != "HEAD"}
    assert own == TEACHING


def _client_paths(file: Path, base: str) -> set[str]:
    """Every path a web client module names in a request or a URL, with `${...}` as a parameter."""
    text = file.read_text(encoding="utf-8")
    found = re.findall(r"""request<[^>]*>\(\s*[`"](/[^`"?]*)""", text)
    found += re.findall(r"""\$\{(?:API_BASE|V2_BASE)\}(/[^`"?]*)""", text)
    return {base + re.sub(r"\$\{[^}]+\}", "{x}", p) for p in found}


def test_every_path_the_web_names_is_served(dirs):
    app = app_for(dirs)
    patterns = [re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", p) + "$") for _, p in served(app)]
    web = ROOT / "playground" / "frontend" / "src" / "api"
    wanted = _client_paths(web / "client.ts", "/api") | _client_paths(web / "v2.ts", "/api/v2")
    missing = sorted(p for p in wanted if not any(rx.match(p.replace("{x}", "x")) for rx in patterns))
    assert not missing, "the web names paths the server does not serve: " + ", ".join(missing)


SHA = "a" * 64

#: Every route Task 21 deleted, as (method, path). The schema test above cannot
#: see a route hidden from the schema, so each is also asked for here.
DELETED = [
    ("GET", "/api/registry"),
    ("POST", "/api/explain"),
    ("GET", "/api/sources"),
    ("POST", "/api/sources"),
    ("DELETE", f"/api/sources/{SHA}"),
    ("GET", f"/api/sources/{SHA}/file"),
    ("GET", f"/api/sources/{SHA}/pages"),
    ("GET", f"/api/sources/{SHA}/pages/1.png"),
    ("GET", f"/api/sources/{SHA}/pages/1/find?text=x"),
    ("GET", f"/api/sources/{SHA}/questions"),
    ("POST", f"/api/sources/{SHA}/questions"),
    ("DELETE", f"/api/sources/{SHA}/questions"),
    ("POST", "/api/runs"),
    ("GET", "/api/runs/x"),
    ("GET", "/api/runs/x/events"),
    ("POST", "/api/runs/x/cancel"),
    ("POST", "/api/sweeps"),
    ("GET", f"/api/artifacts/{SHA}"),
    ("GET", f"/api/artifacts/{SHA}/payload"),
    ("DELETE", "/api/cache"),
    ("POST", "/api/trace"),
    ("GET", "/api/settings/llm"),
    ("POST", "/api/settings/llm/check"),
]


def test_every_deleted_route_is_gone(client):
    served = {(m, p): client.request(m, p, json={}).status_code for m, p in DELETED}
    assert {k: v for k, v in served.items() if v not in (404, 405)} == {}
