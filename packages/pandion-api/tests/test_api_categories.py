"""Categories and routes in the pipeline, the run result and the strategies."""

import copy

from apihelpers import PIPELINE, finish, upload
from pdfs import build_pdf

CHUNK = {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10}
CATEGORIES = {
    "categories": {
        "reports": {"name": "Reports", "parse": {"use": "pdfium"}, "chunk": CHUNK},
        "text": {"parse": {"use": "pdfium"}, "clean": [{"use": "dedupe_blocks"}], "chunk": CHUNK},
    },
    "route": [
        {"when": {"use": "name", "pattern": "inv*"}, "category": "reports"},
        {"category": "text"},
    ],
    "index": {"embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}},
    "retrieve": PIPELINE["retrieve"],
    "answer": PIPELINE["answer"],
}


def validate(client, config):
    return client.post("/pipelines/validate", json={"config": config})


def test_old_config_validates_and_comes_back_unchanged(client):
    body = validate(client, PIPELINE).json()
    assert body["ok"] is True and body["config"] == PIPELINE


def test_categories_config_validates_and_round_trips(client):
    body = validate(client, CATEGORIES).json()
    assert body["ok"] is True
    assert body["config"] == CATEGORIES
    assert "categories" in body["yaml"] and "parse" not in body["config"]["index"]


def test_unknown_check_is_a_422_with_its_place(client):
    bad = copy.deepcopy(CATEGORIES)
    bad["route"][0]["when"] = [{"use": "name", "pattern": "a*"}, {"use": "nope"}]
    body = validate(client, bad).json()
    assert body["ok"] is False and body["details"][0]["step"] == "route.1.when.2"


def test_plugins_are_still_refused_with_categories(client):
    body = validate(client, {**CATEGORIES, "plugins": ["os"]}).json()
    assert body["ok"] is False and "plugins" in body["problems"][0]


def test_a_category_id_with_a_capital_is_refused_naming_it(client):
    bad = copy.deepcopy(CATEGORIES)
    bad["categories"]["Text"] = bad["categories"].pop("text")
    bad["route"][-1]["category"] = "Text"
    body = validate(client, bad).json()
    assert body["ok"] is False and "'Text'" in body["problems"][0]


def test_strategies_lists_the_seven_checks(client):
    stages = client.get("/strategies").json()["stages"]
    assert set(stages["route"]) == {
        "file_type", "name", "path", "metadata", "properties", "text_layer", "contains",
    }


def run(client, config, shas, **extra):
    return finish(client, client.post("/runs", json={"config": config, "documents": shas, **extra}))


def test_run_result_names_each_documents_category_and_reason(client):
    a = upload(client, "inv1.pdf")["sha"]
    b = upload(client, "other.pdf", build_pdf([["Another."]]))["sha"]
    state, _ = run(client, CATEGORIES, [a, b], through="parse")
    result = state["result"]
    assert result["categories"]["inv1.pdf"] == {"category": "reports", "reason": "Rule 1: name matches inv*"}
    assert result["categories"]["other.pdf"]["category"] == "text"
    assert result["categories"]["other.pdf"]["reason"].startswith("Default: no rule matched")
    assert list(result["documents"]["inv1.pdf"]) == ["source", "parse"]


def test_through_accepts_a_step_any_category_has_and_refuses_others(client):
    sha = upload(client, "inv1.pdf")["sha"]
    state, _ = run(client, CATEGORIES, [sha], through="clean.1")
    assert state["status"] == "finished"
    r = client.post("/runs", json={"config": CATEGORIES, "documents": [sha], "through": "clean.2"})
    assert r.status_code == 400
    assert "one of parse, clean, clean.1, chunk, index" in r.json()["detail"]


def test_compare_a_stage_in_a_categories_pipeline_sets_it_in_every_category():
    from pandion_api.pipelines import variant_config

    out = variant_config(CATEGORIES, "chunk", {"use": "recursive_character", "chunk_size": 30})
    assert [c["chunk"]["chunk_size"] for c in out["categories"].values()] == [30, 30]
    assert "chunk" not in out["index"]
