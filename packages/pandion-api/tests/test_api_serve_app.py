"""create_app(mode="serve"): which routes it mounts, how it starts, health and ready."""

import pytest
from fastapi.testclient import TestClient

from apihelpers import make_serve_client, settings
from pandion import Pipeline
from pandion_api import create_app


def test_serve_mounts_only_the_serve_routes(tmp_path):
    with make_serve_client(tmp_path) as c:
        for path in ("/strategies", "/documents", "/runs", "/evaluations", "/settings/models"):
            assert c.get(path).status_code == 404, path
        assert c.get("/health").status_code == 200


def test_serve_needs_a_pipeline_path(tmp_path):
    with pytest.raises(ValueError, match="pipeline="):
        create_app(settings(tmp_path), mode="serve")


def test_a_bad_pipeline_file_stops_startup_with_pandions_sentence(tmp_path):
    file = tmp_path / "bad.yaml"
    file.write_text(
        "index: {parse: {use: no-such-parser}, chunk: {use: recursive_character}, "
        "embed: {use: fake-deterministic}, store: {use: lancedb}}\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="no-such-parser") as caught:
        create_app(settings(tmp_path), mode="serve", pipeline=file)
    assert "Traceback" not in str(caught.value)


def test_a_missing_pipeline_file_stops_startup_with_a_sentence(tmp_path):
    with pytest.raises(ValueError, match="could not be read"):
        create_app(settings(tmp_path), mode="serve", pipeline=tmp_path / "nope.yaml")


def test_the_pipeline_is_loaded_once_at_startup(tmp_path, monkeypatch):
    loads = []
    original = Pipeline.from_dict.__func__
    monkeypatch.setattr(Pipeline, "from_dict", classmethod(lambda cls, *a, **k: loads.append(1) or original(cls, *a, **k)))
    with make_serve_client(tmp_path, indexed=False) as c:
        before = len(loads)
        c.get("/health")
        c.get("/ready")
    assert before == 1 and len(loads) == 1


def test_ready_is_true_with_a_reachable_store_and_503_without_a_reason(tmp_path):
    with make_serve_client(tmp_path) as c:
        assert c.get("/ready").json() == {"ready": True}

    class Broken:
        def check(self):
            raise RuntimeError("secret database detail")

    with make_serve_client(tmp_path, store=Broken()) as c:
        r = c.get("/ready")
        assert r.status_code == 503 and r.json() == {"ready": False}
        assert "secret" not in r.text


def test_ready_is_503_before_anything_is_indexed(tmp_path):
    with make_serve_client(tmp_path, indexed=False) as c:
        assert c.get("/ready").status_code == 503


def test_health_is_ok_and_names_no_version(tmp_path):
    with make_serve_client(tmp_path) as c:
        assert c.get("/health").json() == {"status": "ok"}


def test_the_warm_up_runs_one_search_when_indexed(tmp_path, monkeypatch):
    asked = []
    original = Pipeline.retrieve
    monkeypatch.setattr(Pipeline, "retrieve", lambda self, q, *a, **k: asked.append(q) or original(self, q, *a, **k))
    with make_serve_client(tmp_path):
        pass
    assert asked == ["warm up"]


def test_warm_up_failure_does_not_stop_the_server(tmp_path, monkeypatch):
    def boom(self, *a, **k):
        raise RuntimeError("model download failed")

    monkeypatch.setattr(Pipeline, "retrieve", boom)
    with make_serve_client(tmp_path) as c:
        assert c.get("/health").status_code == 200


def test_lab_mode_is_unchanged(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as c:
        assert c.get("/strategies").status_code == 200
        assert c.get("/ready").status_code == 404
