"""Question sets: the samples' JSON format, CSV, or a list in code, checked."""

import json
from pathlib import Path

import pytest

import pandion
from pandion.evaluation import QuestionSetError, check_questions, load_questions

SAMPLES = Path(__file__).resolve().parents[3] / "samples"

CAPITAL = {
    "id": "capital",
    "question": "What is the capital of France?",
    "gold_answer": "The capital of France is Paris.",
    "tags": ["fact"],
}


def test_evaluation_is_a_public_namespace():
    assert "evaluation" in pandion.__all__
    for name in ("GOLD_SEPARATOR", "QuestionSetError", "check_questions", "load_questions",
                 "parse_question_set"):
        assert name in pandion.evaluation.__all__ and hasattr(pandion.evaluation, name)


def test_a_list_in_code_is_read_like_a_file():
    questions = load_questions([CAPITAL])["questions"]
    assert questions == [{
        "id": "capital",
        "question": "What is the capital of France?",
        "gold_answers": ["The capital of France is Paris."],
        "answer": "",
        "tags": ["fact"],
        "document": "",
    }]


def test_a_dict_with_a_questions_list_is_read(tmp_path):
    loaded = load_questions({"version": 1, "document": "a.pdf", "questions": [CAPITAL]})
    assert loaded["document"] == "a.pdf"
    assert loaded["questions"][0]["document"] == "a.pdf"


def test_a_json_file_in_the_samples_format(tmp_path):
    f = tmp_path / "questions.json"
    f.write_text(json.dumps([CAPITAL]), encoding="utf-8")
    assert load_questions(f)["format"] == "json"
    assert load_questions(str(f))["questions"][0]["id"] == "capital"


def test_a_csv_file(tmp_path):
    f = tmp_path / "questions.csv"
    f.write_text(
        "id,question,gold_answers\ncapital,What is the capital of France?,The capital of France is Paris.\n",
        encoding="utf-8",
    )
    loaded = load_questions(f)
    assert loaded["format"] == "csv"
    assert loaded["questions"][0]["gold_answers"] == ["The capital of France is Paris."]


@pytest.mark.skipif(not SAMPLES.is_dir(), reason="runs inside the repo, where the samples are")
@pytest.mark.parametrize("name", ["chunking-primer", "two-column-report", "table-of-figures", "scanned-notes"])
def test_every_bundled_sample_set_loads(name):
    assert load_questions(SAMPLES / name / "questions.json")["questions"]


def test_a_question_without_a_gold_passage_is_refused_in_a_sentence():
    with pytest.raises(QuestionSetError) as caught:
        load_questions([CAPITAL, {"question": "Why?"}])
    message = str(caught.value)
    assert message.startswith("The question set you gave cannot be used: question 2: no gold passage.")
    assert message.endswith(".")


def test_a_missing_file_is_named(tmp_path):
    with pytest.raises(QuestionSetError, match=r"There is no question set at .*nope\.json\."):
        load_questions(tmp_path / "nope.json")


def test_something_else_is_refused():
    with pytest.raises(QuestionSetError, match="a path to a JSON or CSV file"):
        load_questions(42)


def test_the_check_finds_a_passage_with_curly_quotes():
    rows = check_questions(
        [{"question": "q", "gold_answers": ["The reader's eye stops."]}],
        "The reader’s eye stops.",
    )
    assert rows[0]["status"] == "found_normalized"
