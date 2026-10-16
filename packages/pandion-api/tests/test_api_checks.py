"""Reading a pipeline dict step by step, for a site's rules."""

import pandion
from apihelpers import PIPELINE
from pandion_api.checks import changed_read_only_settings, custom_endpoint_steps, steps

CUSTOM = {"model": "custom", "custom_base_url": "https://models.example.com/v1", "custom_model": "m"}


def test_steps_name_every_step_as_the_file_does():
    config = {
        **PIPELINE,
        "index": {**PIPELINE["index"], "clean": [{"use": "dedupe_blocks"}, {"use": "header_footer_strip"}]},
        "retrieve": {"rewrite": {"use": "text"}, "search": {"use": "dense"}, "rerank": [{"use": "mmr"}]},
    }
    assert [(where, stage, use) for where, stage, use, _ in steps(config)] == [
        ("index.parse", "parse", "pdfium"),
        ("index.chunk", "chunk", "recursive_character"),
        ("index.store", "index", "lancedb"),
        ("retrieve.rewrite", "query", "text"),
        ("retrieve.search", "retrieve", "dense"),
        ("index.clean.1", "clean", "dedupe_blocks"),
        ("index.clean.2", "clean", "header_footer_strip"),
        ("retrieve.rerank.1", "rerank", "mmr"),
        ("answer", "use_case", "search"),
    ]
    assert steps(config)[1][3] == {"chunk_size": 70, "chunk_overlap": 10}


def test_steps_include_the_enrich_step():
    config = {**PIPELINE, "index": {**PIPELINE["index"], "enrich": {"use": "llm_context", **CUSTOM}}}
    assert ("index.enrich", "enrich", "llm_context") in [s[:3] for s in steps(config)]
    assert custom_endpoint_steps(config) == ["index.enrich"]


def test_steps_skip_what_is_not_a_step():
    assert steps({"index": 3, "retrieve": {"search": "dense"}, "answer": None}) == []


def test_a_custom_endpoint_is_found_on_every_step_that_calls_a_model():
    config = {
        **PIPELINE,
        "retrieve": {
            "rewrite": {"use": "llm_rewrite", **CUSTOM},
            "search": {"use": "dense"},
            "rerank": [{"use": "llm_rerank", **CUSTOM}],
        },
        "answer": {"use": "chat", **CUSTOM},
    }
    assert custom_endpoint_steps(config) == ["retrieve.rewrite", "retrieve.rerank.1", "answer"]
    assert custom_endpoint_steps(PIPELINE) == []
    assert custom_endpoint_steps({**PIPELINE, "answer": {"use": "chat", "model": "claude-haiku-4-5"}}) == []


def test_a_changed_read_only_setting_is_found_and_its_default_is_not():
    default = pandion.catalog()["use_case"]["chat"]["config_schema"]["properties"]["prompt"]["default"]
    assert changed_read_only_settings({**PIPELINE, "answer": {"use": "chat", "prompt": default}}) == []
    assert changed_read_only_settings({**PIPELINE, "answer": {"use": "chat", "prompt": "Say yes."}}) == ["answer.prompt"]
    reranked = {**PIPELINE, "retrieve": {"search": {"use": "dense"}, "rerank": [{"use": "cross_encoder", "revision": "a" * 40}]}}
    assert changed_read_only_settings(reranked) == ["retrieve.rerank.1.revision"]


def test_a_model_that_is_not_a_string_is_not_a_custom_endpoint():
    for model in (["custom"], {"a": 1}, 3, None):
        assert custom_endpoint_steps({**PIPELINE, "answer": {"use": "chat", "model": model}}) == []
