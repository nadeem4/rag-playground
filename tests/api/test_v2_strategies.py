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
