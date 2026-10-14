"""On /api/v2 the catalog, the custom endpoint ban and the fixed prompts hold
exactly as on the old routes (`/api/registry`, `/api/runs`, `/api/explain`)."""

from __future__ import annotations

import pytest

from api.routes.runs import DEMO_NO_CUSTOM, PROMPTS_FIXED

PIPELINE = {
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "hybrid_rrf"}},
    "answer": {"use": "search"},
}
CUSTOM = {"model": "custom", "custom_base_url": "https://models.example.com/v1", "custom_model": "m"}
CUSTOM_CONFIGS = {
    "chat": {**PIPELINE, "answer": {"use": "chat", **CUSTOM}},
    "llm_rerank": {**PIPELINE, "retrieve": {**PIPELINE["retrieve"], "rerank": [{"use": "llm_rerank", **CUSTOM}]}},
    "llm_rewrite": {**PIPELINE, "retrieve": {**PIPELINE["retrieve"], "rewrite": {"use": "llm_rewrite", **CUSTOM}}},
}
FIXED_CONFIGS = {
    "prompt": {**PIPELINE, "answer": {"use": "chat", "prompt": "Say yes."}},
    "revision": {**PIPELINE, "retrieve": {**PIPELINE["retrieve"], "rerank": [{"use": "cross_encoder", "revision": "a" * 40}]}},
}


def demo_on(monkeypatch) -> None:
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")


def validate(client, config):
    return client.post("/api/v2/pipelines/validate", json={"config": config})


@pytest.mark.parametrize("demo", [False, True])
def test_the_catalog_is_the_one_the_old_registry_serves(client, monkeypatch, demo):
    if demo:
        demo_on(monkeypatch)
    assert client.get("/api/v2/strategies").json()["stages"] == client.get("/api/registry").json()


@pytest.mark.parametrize("name", list(CUSTOM_CONFIGS))
def test_on_the_demo_a_custom_endpoint_is_refused(client, monkeypatch, name):
    demo_on(monkeypatch)
    r = validate(client, CUSTOM_CONFIGS[name])
    assert r.status_code == 403 and r.json()["detail"] == DEMO_NO_CUSTOM


@pytest.mark.parametrize("name", list(CUSTOM_CONFIGS))
def test_outside_the_demo_a_custom_endpoint_is_not_refused(client, name):
    assert validate(client, CUSTOM_CONFIGS[name]).json()["ok"] is True


@pytest.mark.parametrize("demo", [False, True])
@pytest.mark.parametrize("name", list(FIXED_CONFIGS))
def test_a_changed_prompt_or_revision_is_refused_in_every_mode(client, monkeypatch, demo, name):
    if demo:
        demo_on(monkeypatch)
    r = validate(client, FIXED_CONFIGS[name])
    assert r.status_code == 403 and r.json()["detail"] == PROMPTS_FIXED


def test_on_the_demo_the_custom_endpoint_is_refused_before_a_fixed_prompt(client, monkeypatch):
    demo_on(monkeypatch)
    both = {**PIPELINE, "answer": {"use": "chat", "prompt": "Say yes.", **CUSTOM}}
    assert validate(client, both).json()["detail"] == DEMO_NO_CUSTOM


def test_explain_matches_the_old_route(client):
    old = client.post("/api/explain", json={"stage": "chunk", "transform": "recursive_character", "config": {"chunk_size": 200}})
    new = client.post("/api/v2/explain", json={"stage": "chunk", "use": "recursive_character", "settings": {"chunk_size": 200}})
    assert new.status_code == old.status_code == 200 and new.json() == old.json()


def test_a_model_may_write_at_most_16000_tokens(client):
    def answer(n):
        return {**PIPELINE, "answer": {"use": "chat", "max_tokens": n}}

    assert validate(client, answer(16000)).json()["ok"] is True
    r = validate(client, answer(16001))
    assert r.status_code == 403
    assert r.json()["detail"] == "answer.max_tokens is 16001; the playground allows at most 16000."


def test_a_chunk_size_named_max_tokens_is_not_capped(client):
    chunk = {"use": "token_based", "max_tokens": 20000}
    config = {**PIPELINE, "index": {**PIPELINE["index"], "chunk": chunk}}
    assert validate(client, config).json()["ok"] is True


def test_a_text_budget_may_be_at_most_four_times_its_default(client):
    import pandion

    props = pandion.catalog()["rerank"]["llm_rerank"]["config_schema"]["properties"]
    cap = 4 * props["text_budget_chars"]["default"]

    def reranked(n):
        return {**PIPELINE, "retrieve": {**PIPELINE["retrieve"], "rerank": [{"use": "llm_rerank", "text_budget_chars": n}]}}

    assert validate(client, reranked(cap)).json()["ok"] is True
    r = validate(client, reranked(cap + 1))
    assert r.status_code == 403
    assert r.json()["detail"] == f"retrieve.rerank.1.text_budget_chars is {cap + 1}; the playground allows at most {cap}."


# --- the same caps on the old /api/runs and /api/sweeps ---------------------------


def chat_graph(config: dict) -> dict:
    return {"nodes": [{"id": "chat", "stage": "use_case", "transform": "chat", "config": config}], "edges": []}


def test_the_old_runs_route_caps_a_model_output_as_v2_does(client):
    r = client.post("/api/runs", json={"graph": chat_graph({"max_tokens": 16001})})
    assert r.status_code == 403
    assert r.json()["detail"] == "chat.max_tokens is 16001; the playground allows at most 16000."
    at_the_cap = client.post("/api/runs", json={"graph": chat_graph({"max_tokens": 16000})})
    assert at_the_cap.status_code != 403


def test_an_override_cannot_lift_the_cap_on_the_old_runs_route(client):
    r = client.post("/api/runs", json={"graph": chat_graph({}), "overrides": {"chat": {"max_tokens": 20000}}})
    assert r.status_code == 403
    assert r.json()["detail"] == "chat.max_tokens is 20000; the playground allows at most 16000."


def test_the_old_sweeps_route_caps_a_text_budget_as_v2_does(client):
    import pandion

    props = pandion.catalog()["rerank"]["llm_rerank"]["config_schema"]["properties"]
    cap = 4 * props["text_budget_chars"]["default"]
    graph = {"nodes": [{"id": "rr", "stage": "rerank", "transform": "llm_rerank", "config": {}}], "edges": []}
    r = client.post(
        "/api/sweeps",
        json={"graph": graph, "node_id": "rr",
              "variants": [{"transform": "llm_rerank", "config": {}},
                           {"transform": "llm_rerank", "config": {"text_budget_chars": cap + 1}}]},
    )
    assert r.status_code == 403
    assert r.json()["detail"] == f"rr.text_budget_chars is {cap + 1}; the playground allows at most {cap}."


# --- a cap reads the value as pydantic will: a string or a float is no way around it ---

#: Sent as a string or a float, each is the number pydantic makes of it.
OVER_THE_CAP = ["999999", 999999.0, "16001"]
AT_THE_CAP = ["16000", 16000.0]


def _answer(n) -> dict:
    return {**PIPELINE, "answer": {"use": "chat", "max_tokens": n}}


@pytest.mark.parametrize("sent", OVER_THE_CAP)
def test_a_cap_cannot_be_passed_with_a_string_or_a_float_on_validate(client, sent):
    r = validate(client, _answer(sent))
    assert r.status_code == 403
    assert r.json()["detail"] == f"answer.max_tokens is {int(float(sent))}; the playground allows at most 16000."


@pytest.mark.parametrize("sent", AT_THE_CAP)
def test_a_string_or_a_float_at_the_cap_passes_it_on_validate(client, sent):
    assert validate(client, _answer(sent)).json()["ok"] is True


@pytest.mark.parametrize("sent", OVER_THE_CAP)
def test_a_cap_cannot_be_passed_with_a_string_or_a_float_on_a_v2_run(client, sent):
    sample = client.post("/api/sources/sample").json()
    r = client.post("/api/v2/runs", json={"config": _answer(sent), "documents": [sample["sha"]], "through": "parse"})
    assert r.status_code == 403
    assert r.json()["detail"] == f"answer.max_tokens is {int(float(sent))}; the playground allows at most 16000."


@pytest.mark.parametrize("sent", AT_THE_CAP)
def test_a_string_or_a_float_at_the_cap_passes_it_on_a_v2_run(client, sent):
    sample = client.post("/api/sources/sample").json()
    r = client.post("/api/v2/runs", json={"config": _answer(sent), "documents": [sample["sha"]], "through": "parse"})
    assert r.status_code == 202


def test_a_text_budget_cannot_be_passed_with_a_string(client):
    import pandion

    props = pandion.catalog()["rerank"]["llm_rerank"]["config_schema"]["properties"]
    cap = 4 * props["text_budget_chars"]["default"]
    config = {**PIPELINE, "retrieve": {**PIPELINE["retrieve"], "rerank": [{"use": "llm_rerank", "text_budget_chars": str(cap + 1)}]}}
    r = validate(client, config)
    assert r.status_code == 403
    assert r.json()["detail"] == f"retrieve.rerank.1.text_budget_chars is {cap + 1}; the playground allows at most {cap}."


@pytest.mark.parametrize("sent", OVER_THE_CAP)
def test_the_old_runs_route_refuses_a_string_or_a_float_over_the_cap(client, sent):
    r = client.post("/api/runs", json={"graph": chat_graph({"max_tokens": sent})})
    assert r.status_code == 403
    assert r.json()["detail"] == f"chat.max_tokens is {int(float(sent))}; the playground allows at most 16000."


@pytest.mark.parametrize("sent", AT_THE_CAP)
def test_the_old_runs_route_lets_a_string_or_a_float_at_the_cap_pass_it(client, sent):
    r = client.post("/api/runs", json={"graph": chat_graph({"max_tokens": sent})})
    assert r.status_code != 403
