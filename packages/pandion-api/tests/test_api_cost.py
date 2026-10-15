"""Speed and cost in a run's JSON: each step's `usage`, and `cost` on every report.

A made-up rerank step records usage for a model with no price, so these tests
also show how an unpriced custom model comes back: listed in `unpriced_models`,
with `dollars` null.
"""

import pytest

from apihelpers import PIPELINE, finish, upload
from pandion.artifacts import ArtifactType
from pandion.extend import PortSpec, Stage, Transform, register, set_usage
from fakes import EmptyCfg

QUESTION = "What is the capital of France?"
QUESTIONS = [
    {"id": "capital", "question": QUESTION, "gold_answers": ["The capital of France is Paris."]}
]
VARIANTS = [
    {"use": "recursive_character", "chunk_size": 70},
    {"use": "recursive_character", "chunk_size": 200},
]
COST_KEYS = {
    "seconds", "input_tokens", "output_tokens", "dollars", "unpriced_models",
    "uncounted_models", "steps_run", "steps_cached", "prices_as_of",
}
MODEL = "my-custom-model"
USAGE = {"input_tokens": 9, "output_tokens": 4, "model": MODEL}

#: PIPELINE with a rerank step that records usage for MODEL.
WITH_MODEL = {
    **PIPELINE,
    "retrieve": {**PIPELINE["retrieve"], "rerank": {"use": "test_api_usage_rerank"}},
}


@pytest.fixture(autouse=True)
def usage_rerank():
    """A rerank step that keeps the order and records made-up usage; removed after each test."""

    @register
    class UsageRerank(Transform[EmptyCfg]):
        name = "test_api_usage_rerank"
        stage = Stage.RERANK
        inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = EmptyCfg
        summary = "Keeps the order and records made-up usage."

        def apply(self, inputs, config, ctx):
            set_usage(ctx, {"input_tokens": 9, "output_tokens": 4}, MODEL)
            return inputs["result"]

    yield
    from pandion.registry import registry

    registry._by_stage[Stage.RERANK].pop("test_api_usage_rerank", None)


def unpriced(cost: dict) -> None:
    assert set(cost) == COST_KEYS
    assert cost["unpriced_models"] == [MODEL]
    assert cost["dollars"] is None
    assert cost["input_tokens"] == 9 and cost["output_tokens"] == 4


def test_a_model_step_has_its_usage_and_a_model_free_step_has_none(client):
    sha = upload(client)["sha"]
    body = {"config": WITH_MODEL, "documents": [sha], "question": QUESTION, "answer": False}
    state, _ = finish(client, client.post("/ask", json=body))
    steps = state["result"]["steps"]
    assert state["ok"] is True
    assert steps["rerank"][0]["usage"] == USAGE
    assert steps["search"]["usage"] is None
    assert state["result"]["index"]["usage"] is None
    unpriced(state["result"]["cost"])


def test_an_answer_has_its_cost(client):
    sha = upload(client)["sha"]
    body = {"config": WITH_MODEL, "documents": [sha], "question": QUESTION}
    state, _ = finish(client, client.post("/ask", json=body))
    assert state["result"]["answer"]["usage"] is None
    unpriced(state["result"]["cost"])


def test_an_index_run_has_its_cost(client):
    sha = upload(client)["sha"]
    state, _ = finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    cost = state["result"]["cost"]
    assert set(cost) == COST_KEYS
    assert cost["steps_run"] == 4 and cost["input_tokens"] is None and cost["dollars"] is None
    assert state["result"]["documents"]["report.pdf"]["parse"]["usage"] is None


def test_an_evaluation_has_its_cost(client):
    sha = upload(client)["sha"]
    body = {"config": WITH_MODEL, "documents": [sha], "questions": QUESTIONS}
    state, _ = finish(client, client.post("/evaluations", json=body))
    assert state["ok"] is True
    unpriced(state["result"]["cost"])


def test_each_comparison_and_the_list_have_their_cost(client):
    sha = upload(client)["sha"]
    body = {"config": WITH_MODEL, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "questions": QUESTIONS}
    state, _ = finish(client, client.post("/comparisons", json=body))
    result = state["result"]
    assert state["ok"] is True
    for c in result["comparisons"]:
        unpriced(c["cost"])
    assert set(result["cost"]) == COST_KEYS
    assert result["cost"]["input_tokens"] == 18 and result["cost"]["unpriced_models"] == [MODEL]


@pytest.mark.parametrize("answer", [False, True])
def test_a_comparison_on_one_question_has_each_cost_and_the_lists(client, answer):
    sha = upload(client)["sha"]
    body = {
        "config": WITH_MODEL, "stage": "chunk", "variants": VARIANTS, "documents": [sha],
        "question": QUESTION, "answer": answer,
    }
    state, _ = finish(client, client.post("/comparisons", json=body))
    result = state["result"]
    assert state["ok"] is True
    for c in result["comparisons"]:
        unpriced(c["cost"])
    assert result["cost"]["input_tokens"] == 18 and result["cost"]["dollars"] is None


def test_the_total_of_several_costs_keeps_none_apart_from_zero():
    from pandion_api.reports import total

    priced = {
        "seconds": 1.0, "input_tokens": 10, "output_tokens": 2, "dollars": 0.5,
        "unpriced_models": [], "uncounted_models": [], "steps_run": 3, "steps_cached": 1,
        "prices_as_of": "2026-10-15",
    }
    local = {**priced, "input_tokens": None, "output_tokens": None, "dollars": None, "unpriced_models": ["b", "a"]}
    assert total([priced, local]) == {
        **priced, "seconds": 2.0, "unpriced_models": ["a", "b"], "steps_run": 6, "steps_cached": 2,
    }
    assert total([local])["dollars"] is None
    assert total([]) is None
