"""Pipeline templates: `pandion.list_templates` and `pandion.compose_template`."""

from __future__ import annotations

import pytest

import pandion


def _by_id(family: str) -> dict[str, dict]:
    return {t["id"]: t for t in pandion.list_templates()[family]}


def test_both_families_have_their_templates():
    assert set(_by_id("documents")) == {"text", "tables", "scanned", "manuals"}
    assert set(_by_id("questions")) == {"balanced", "exact", "precision", "vague", "chat"}


@pytest.mark.parametrize("family", ["documents", "questions"])
def test_every_template_names_itself_and_says_what_it_is_good_for(family):
    for t in pandion.list_templates()[family]:
        assert t["name"] and t["summary"] and t["good_for"], t["id"]
        assert "\N{EM DASH}" not in t["summary"] + t["good_for"], f"{t['id']} has an em-dash"


def test_a_document_template_sets_the_index_and_names_a_sample():
    for t in _by_id("documents").values():
        assert set(t["pipeline"]) == {"index"}, t["id"]
        assert t["sample"], t["id"]


def test_a_question_template_sets_retrieval_and_the_answer_and_says_if_it_needs_a_key():
    questions = _by_id("questions")
    for t in questions.values():
        assert set(t["pipeline"]) == {"retrieve", "answer"}, t["id"]
    assert sorted(q for q, t in questions.items() if t["needs_key"]) == ["chat", "vague"]


def test_compose_joins_a_document_and_a_question_template():
    config = pandion.compose_template("text", "balanced")

    assert config == {
        "path": "./pandion-index",
        **_by_id("documents")["text"]["pipeline"],
        **_by_id("questions")["balanced"]["pipeline"],
    }


def test_compose_takes_the_folder_and_hands_back_a_copy():
    config = pandion.compose_template("tables", "precision", path="my-index")
    config["index"]["parse"]["use"] = "changed"

    assert config["path"] == "my-index"
    assert pandion.compose_template("tables", "precision")["index"]["parse"]["use"] == "docling"


def test_an_unknown_template_names_the_ones_there_are():
    with pytest.raises(ValueError, match="no document template named 'nope'.*manuals, scanned, tables, text"):
        pandion.compose_template("nope", "balanced")
    with pytest.raises(ValueError, match="no question template named 'nope'.*balanced, chat"):
        pandion.compose_template("text", "nope")


@pytest.mark.parametrize("document", ["text", "tables", "scanned", "manuals"])
def test_every_composed_pair_is_a_valid_pipeline(document, tmp_path):
    for question in _by_id("questions"):
        pandion.Pipeline.from_dict(pandion.compose_template(document, question, path=str(tmp_path)))
