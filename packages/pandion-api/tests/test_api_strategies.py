"""GET /strategies, POST /explain and POST /pipelines/validate."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import pandion
from apihelpers import PIPELINE, make_client, settings
from pandion_api import Policy, create_app
from pandion_api.pipelines import PLUGINS_REFUSED


def test_strategies_list_every_stage_and_the_defaults(client):
    body = client.get("/strategies").json()
    assert body["stages"] == pandion.catalog()
    assert body["defaults"] == pandion.defaults()


def test_a_policy_filters_the_strategies_on_a_copy(tmp_path):
    class NoDocling(Policy):
        def strategies(self, catalog, request):
            catalog["parse"].pop("docling")
            return catalog

    with make_client(tmp_path, NoDocling()) as c:
        assert "docling" not in c.get("/strategies").json()["stages"]["parse"]
    assert "docling" in pandion.catalog()["parse"]


def test_explain_says_what_a_strategy_will_do(client):
    r = client.post("/explain", json={"stage": "chunk", "use": "recursive_character", "settings": {"chunk_size": 200}})
    assert r.status_code == 200
    assert r.json() == pandion.explain("chunk", "recursive_character", {"chunk_size": 200})


def test_explain_an_unknown_strategy_is_404_and_a_bad_value_422(client):
    assert client.post("/explain", json={"stage": "chunk", "use": "nope"}).status_code == 404
    assert client.post("/explain", json={"stage": "nope", "use": "x"}).status_code == 404
    r = client.post("/explain", json={"stage": "chunk", "use": "recursive_character", "settings": {"chunk_size": "big"}})
    assert r.status_code == 422
    assert "chunk_size" in r.json()["detail"]["problems"][0]


def test_a_valid_pipeline_comes_back_in_the_files_shape_without_server_folders(client):
    r = client.post("/pipelines/validate", json={"config": PIPELINE})
    body = r.json()
    assert r.status_code == 200 and body["ok"] is True and body["problems"] == []
    assert "path" not in body["config"] and "models" not in body["config"]
    assert body["config"]["index"]["chunk"] == PIPELINE["index"]["chunk"]


def test_a_problem_is_a_sentence_not_an_error(client):
    bad = {**PIPELINE, "index": {**PIPELINE["index"], "chunk": {"use": "nope"}}}
    body = client.post("/pipelines/validate", json={"config": bad}).json()
    assert body["ok"] is False
    assert body["problems"][0].startswith("index.chunk uses 'nope', which is not a chunk strategy.")


@pytest.mark.parametrize("config", [3, [], {"path": "x"}, {**PIPELINE, "models": 3}])
def test_any_shape_is_a_problem_never_a_500(client, config):
    r = client.post("/pipelines/validate", json={"config": config})
    assert r.status_code == 200 and r.json()["ok"] is False and r.json()["problems"]


def test_a_request_cannot_load_plugins(client):
    body = client.post("/pipelines/validate", json={"config": {**PIPELINE, "plugins": ["os"]}}).json()
    assert body == {"ok": False, "problems": [PLUGINS_REFUSED]}


def test_the_server_decides_the_folder_and_the_models(tmp_path):
    seen: list[dict] = []

    class Spy(Policy):
        def public_endpoints_only(self, request):
            return True

        def check_run(self, config, request):
            seen.append(config)

    with TestClient(create_app(settings(tmp_path), Spy())) as c:
        sent = {**PIPELINE, "path": "/etc", "models": {"cache_dir": "/tmp/x", "device": "cuda"}}
        assert c.post("/pipelines/validate", json={"config": sent}).json()["ok"] is True
    [config] = seen
    assert config["path"] == (tmp_path / "data").as_posix()
    assert config["models"] == {"device": "cpu", "public_endpoints_only": True}


def test_a_policy_refusal_keeps_its_own_status(tmp_path):
    class NoChat(Policy):
        def check_run(self, config, request):
            if config.get("answer", {}).get("use") == "chat":
                raise HTTPException(403, "No chat here.")

    with make_client(tmp_path, NoChat()) as c:
        r = c.post("/pipelines/validate", json={"config": {**PIPELINE, "answer": {"use": "chat"}}})
    assert r.status_code == 403 and r.json()["detail"] == "No chat here."


def test_plugins_are_refused_before_anything_is_imported(tmp_path):
    """The data folder is on the import path while from_dict loads plugins, so a
    module there would run. The refusal comes first: nothing is imported."""
    import sys

    data = tmp_path / "data"
    data.mkdir()
    marker = tmp_path / "imported"
    (data / "spy_plugin.py").write_text(f"open({str(marker)!r}, 'w').close()\n", encoding="utf-8")
    with make_client(tmp_path) as c:
        for plugins in (["spy_plugin"], None, "spy_plugin"):
            body = c.post("/pipelines/validate", json={"config": {**PIPELINE, "plugins": plugins}}).json()
            assert body == {"ok": False, "problems": [PLUGINS_REFUSED]}
    assert not marker.exists() and "spy_plugin" not in sys.modules


@pytest.mark.parametrize("path", ["../elsewhere", "/etc", "C:/Windows"])
def test_a_request_cannot_point_the_pipeline_at_another_folder(tmp_path, path):
    seen: list[str] = []

    class Spy(Policy):
        def check_run(self, config, request):
            seen.append(config["path"])

    with TestClient(create_app(settings(tmp_path), Spy())) as c:
        body = c.post("/pipelines/validate", json={"config": {**PIPELINE, "path": path}}).json()
    assert body["ok"] is True and "path" not in body["config"]
    assert seen == [(tmp_path / "data").as_posix()]


def test_a_problem_leaves_through_the_policys_scrub(tmp_path):
    class Scrubbing(Policy):
        def scrub(self, text):
            return "scrubbed: " + text

    bad = {**PIPELINE, "index": {**PIPELINE["index"], "chunk": {"use": "nope"}}}
    with make_client(tmp_path, Scrubbing()) as c:
        problem = c.post("/pipelines/validate", json={"config": bad}).json()["problems"][0]
        explained = c.post("/explain", json={"stage": "chunk", "use": "recursive_character", "settings": {"chunk_size": "big"}})
        unknown = c.post("/explain", json={"stage": "chunk", "use": "nope"})
    assert problem.startswith("scrubbed: index.chunk uses 'nope'")
    assert explained.json()["detail"]["problems"][0].startswith("scrubbed: ")
    assert unknown.json()["detail"].startswith("scrubbed: ")


def test_the_default_policy_allows_a_changed_prompt_and_any_budget(client):
    config = {
        **PIPELINE,
        "retrieve": {
            "search": {"use": "dense"},
            "rerank": [{"use": "llm_rerank", "text_budget_chars": 10**7, "max_tokens": 10**6}],
        },
        "answer": {"use": "chat", "prompt": "Say yes.", "max_tokens": 10**6},
    }
    assert client.post("/pipelines/validate", json={"config": config}).json()["ok"] is True


def test_a_policys_own_422_keeps_its_detail_not_a_500(tmp_path):
    class Picky(Policy):
        def check_run(self, config, request):
            raise HTTPException(422, detail={"why": "not today"})

    with make_client(tmp_path, Picky()) as c:
        r = c.post("/pipelines/validate", json={"config": PIPELINE})
    assert r.status_code == 422 and r.json()["detail"] == {"why": "not today"}
