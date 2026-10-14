"""playground/templates: the document and question templates, and `compose`,
which joins one of each into a full Pandion pipeline."""

from __future__ import annotations

from pathlib import Path

import pytest

from playground import templates

ROOT = Path(__file__).resolve().parents[1]


def test_both_families_have_the_templates_the_playground_offers():
    assert set(templates.load("documents")) == {"text", "tables", "scanned", "manuals"}
    assert set(templates.load("questions")) == {"balanced", "exact", "precision", "vague", "chat"}


@pytest.mark.parametrize("family", templates.FAMILIES)
def test_every_template_names_itself_and_says_what_it_is_good_for(family):
    for name, data in templates.load(family).items():
        about = data["template"]
        assert about["name"] and about["summary"] and about["good_for"], name
        assert "\N{EM DASH}" not in about["summary"] + about["good_for"], f"{name} has an em-dash"


def test_a_document_template_holds_only_the_index_and_names_a_bundled_sample():
    for name, data in templates.load("documents").items():
        assert set(data) == {"template", "index"}, name
        assert (ROOT / "samples" / data["template"]["sample"] / "sample.json").is_file(), name


def test_a_question_template_holds_only_retrieval_and_the_answer():
    for name, data in templates.load("questions").items():
        assert set(data) == {"template", "retrieve", "answer"}, name


def test_compose_joins_a_document_and_a_question_template_without_the_template_blocks():
    config = templates.compose("text", "balanced")

    assert config == {
        "path": "./pandion-index",
        "index": templates.load("documents")["text"]["index"],
        "retrieve": templates.load("questions")["balanced"]["retrieve"],
        "answer": templates.load("questions")["balanced"]["answer"],
    }


def test_compose_takes_the_folder_and_hands_back_a_copy():
    config = templates.compose("tables", "precision", path="my-index")
    config["index"]["parse"]["use"] = "changed"

    assert config["path"] == "my-index"
    assert templates.compose("tables", "precision")["index"]["parse"]["use"] == "docling"


def test_an_unknown_template_names_the_ones_there_are():
    with pytest.raises(ValueError, match="no document template named 'nope'.*manuals, scanned, tables, text"):
        templates.compose("nope", "balanced")
    with pytest.raises(ValueError, match="no question template named 'nope'.*balanced, chat"):
        templates.compose("text", "nope")


def test_only_the_vague_and_chat_templates_need_a_key():
    assert sorted(q for q in templates.load("questions") if templates.needs_key(q)) == ["chat", "vague"]
