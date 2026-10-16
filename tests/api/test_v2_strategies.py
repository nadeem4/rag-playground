"""On /api/v2 the playground's rules hold: the custom endpoint ban on the demo,
the fixed prompts and model revision, and the caps on model output and text budgets."""

from __future__ import annotations

import pytest

from playground.backend.policy import DEMO_NO_CUSTOM, PROMPTS_FIXED

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
    "llm_context": {**PIPELINE, "index": {**PIPELINE["index"], "enrich": {"use": "llm_context", **CUSTOM}}},
}
FIXED_CONFIGS = {
    "prompt": {**PIPELINE, "answer": {"use": "chat", "prompt": "Say yes."}},
    "context prompt": {**PIPELINE, "index": {**PIPELINE["index"], "enrich": {"use": "llm_context", "prompt": "Say yes."}}},
    "revision": {**PIPELINE, "retrieve": {**PIPELINE["retrieve"], "rerank": [{"use": "cross_encoder", "revision": "a" * 40}]}},
}


def demo_on(monkeypatch) -> None:
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")


def validate(client, config):
    return client.post("/api/v2/pipelines/validate", json={"config": config})


def test_copy_yaml_writes_an_enrich_step_where_pandion_reads_it(client):
    enriched = {**PIPELINE, "index": {**PIPELINE["index"], "enrich": {"use": "llm_context", "max_pieces": 40}}}
    r = validate(client, enriched)
    assert r.json()["ok"] is True
    assert "  chunk:\n    use: recursive_character\n  enrich:\n    use: llm_context\n    max_pieces: 40\n" in r.json()["yaml"]


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
    assert "yaml" not in r.json()


def test_on_the_demo_the_custom_endpoint_is_refused_before_a_fixed_prompt(client, monkeypatch):
    demo_on(monkeypatch)
    both = {**PIPELINE, "answer": {"use": "chat", "prompt": "Say yes.", **CUSTOM}}
    assert validate(client, both).json()["detail"] == DEMO_NO_CUSTOM


def test_a_model_may_write_at_most_16000_tokens(client):
    def answer(n):
        return {**PIPELINE, "answer": {"use": "chat", "max_tokens": n}}

    assert validate(client, answer(16000)).json()["ok"] is True
    r = validate(client, answer(16001))
    assert r.status_code == 403
    assert r.json()["detail"] == "answer.max_tokens is 16001; the playground allows at most 16000."


def test_on_the_demo_llm_context_writes_context_for_at_most_200_pieces(client, monkeypatch):
    from playground.backend import demo

    def enriched(n=None):
        step = {"use": "llm_context"} if n is None else {"use": "llm_context", "max_pieces": n}
        return {**PIPELINE, "index": {**PIPELINE["index"], "enrich": step}}

    assert demo.MAX_CONTEXT_PIECES == 200
    assert validate(client, enriched(5000)).json()["ok"] is True  # locally, no cap
    demo_on(monkeypatch)
    assert validate(client, enriched()).json()["ok"] is True
    assert validate(client, enriched(200)).json()["ok"] is True
    r = validate(client, enriched("201"))
    assert r.status_code == 403
    assert r.json()["detail"] == (
        "index.enrich.max_pieces is 201; the demo writes context for at most 200 pieces "
        "in one run. Lower it, or run the playground locally for more."
    )


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


