"""`text` turns a config string into a Query payload — the sweep seam."""

from __future__ import annotations

from core.artifacts import ArtifactType
from core.payloads import Query
from core.ports import Stage
from core.registry import registry

import plugins.query.text  # noqa: F401  (registers the transform)


def run(text: str = ""):
    cls = registry.get(Stage.QUERY, "text")
    return cls().apply({}, cls.config_model(text=text), None)


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
