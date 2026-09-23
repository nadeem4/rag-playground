"""`text` turns a config string into a Query payload — the sweep seam."""

from __future__ import annotations

from core.artifacts import ArtifactType
from core.payloads import Query
from core.ports import Stage
from core.registry import registry

import plugins.query.text  # noqa: F401  (registers the transform)


def run(text: str = "", **config):
    cls = registry.get(Stage.QUERY, "text")
    return cls().apply({}, cls.config_model(text=text, **config), None)


def test_registered_under_the_query_stage():
    cls = registry.get(Stage.QUERY, "text")
    assert cls.output is ArtifactType.QUERY
    assert cls.inputs == {}


def test_emits_a_query_payload():
    out = run("what is the capital of France?")
    assert out == Query(text="what is the capital of France?").model_dump(mode="json")
    assert out["text"] == "what is the capital of France?"


def test_default_config_yields_an_empty_query():
    assert run() == Query().model_dump(mode="json")


def test_payload_validates_back_into_a_query():
    out = run("hello")
    assert Query(**out).text == "hello"


def test_the_config_is_the_only_thing_that_varies():
    assert run("a") != run("b")


# --------------------------------------------------------------------------
# I-23: the gold answer travels with the question
# --------------------------------------------------------------------------


def test_gold_answer_defaults_to_empty_and_changes_nothing():
    """An ordinary question behaves exactly as it did before I-23."""
    assert run("what is chunking?")["gold_answer"] == ""
    assert run("what is chunking?") == Query(text="what is chunking?").model_dump(
        mode="json"
    )


def test_gold_answer_is_carried_into_the_payload():
    out = run("what is chunking?", gold_answer="Chunks are pieces of a document.")
    assert out["gold_answer"] == "Chunks are pieces of a document."
    assert Query(**out).gold_answer == "Chunks are pieces of a document."


def test_the_gold_answer_varies_the_artifact_too():
    """Sweeping the query node varies the question and its gold together."""
    assert run("a", gold_answer="one") != run("a", gold_answer="two")


def test_explain_mentions_a_gold_answer_only_when_there_is_one():
    cls = registry.get(Stage.QUERY, "text")
    plain = cls().explain(cls.config_model(text="a question?"))
    graded = cls().explain(cls.config_model(text="a question?", gold_answer="A line."))
    assert "gold" not in plain.settings.lower()
    assert "gold" in graded.settings.lower()
