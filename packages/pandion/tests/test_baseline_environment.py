"""The baseline records where it was made, and a comparison from another place is refused."""

from __future__ import annotations

import platform

import pytest

import pandion
from pandion import Pipeline
from pandion.evaluation import check_environment, environment

BASE = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "dense"}},
    "answer": {"use": "search"},
}


def pipeline(**retrieve_and_answer) -> Pipeline:
    return Pipeline.from_dict({**BASE, **retrieve_and_answer})


def test_environment_lists_platform_models_and_version():
    env = environment(pipeline())
    assert env["platform"] == f"{platform.system()}-{platform.machine()}".lower()
    assert env["models"] == ["fake-deterministic"]
    assert env["pandion"] == pandion.__version__


def test_models_include_the_embedder_and_each_llm_step():
    p = pipeline(
        retrieve={
            "rewrite": {"use": "llm_rewrite", "model": "claude-haiku-4-5"},
            "search": {"use": "dense"},
            "rerank": {"use": "llm_rerank", "model": "claude-sonnet-5"},
        },
        answer={"use": "chat", "model": "claude-haiku-4-5"},
    )
    assert environment(p)["models"] == ["claude-haiku-4-5", "claude-sonnet-5", "fake-deterministic"]


def test_a_custom_endpoint_records_its_model_name():
    p = pipeline(answer={"use": "chat", "model": "custom", "custom_model": "my-local-llm"})
    assert "my-local-llm" in environment(p)["models"]
    assert "custom" not in environment(p)["models"]


def test_same_environment_passes_with_no_notes():
    env = {"platform": "linux-x86_64", "models": ["a"], "pandion": "0.7.0"}
    assert check_environment({"environment": env}, dict(env)) == []


def test_a_different_platform_is_refused_with_a_sentence():
    then = {"platform": "linux-x86_64", "models": ["a"], "pandion": "0.7.0"}
    now = {**then, "platform": "windows-amd64"}
    with pytest.raises(ValueError) as e:
        check_environment({"environment": then}, now)
    assert str(e.value) == (
        "This baseline was recorded on linux-x86_64 with models a; this run is on windows-amd64 "
        "with models a, so the comparison would not be fair. Re-record it here with --record-baseline, "
        "or run on the machine that recorded it."
    )


def test_different_models_are_refused():
    then = {"platform": "linux-x86_64", "models": ["a"], "pandion": "0.7.0"}
    with pytest.raises(ValueError, match="with models a; this run is on linux-x86_64 with models a, b"):
        check_environment({"environment": then}, {**then, "models": ["a", "b"]})


def test_a_baseline_without_environment_passes_with_a_note():
    notes = check_environment({"questions": []}, {"platform": "x", "models": [], "pandion": "1"})
    assert notes == ["The baseline has no environment record, so its platform and models were not checked."]


def test_a_different_pandion_version_is_not_refused():
    then = {"platform": "linux-x86_64", "models": ["a"], "pandion": "0.1.0"}
    assert check_environment({"environment": then}, {**then, "pandion": "9.9.9"}) == []


def test_a_step_on_its_default_model_records_that_model():
    p = pipeline(
        retrieve={
            "rewrite": {"use": "llm_rewrite"},
            "search": {"use": "dense"},
            "rerank": {"use": "cross_encoder"},
        },
        answer={"use": "chat"},
    )
    models = environment(p)["models"]
    assert "cross-encoder/ms-marco-MiniLM-L-6-v2" in models
    assert "claude-haiku-4-5" in models and "claude-opus-5" in models
