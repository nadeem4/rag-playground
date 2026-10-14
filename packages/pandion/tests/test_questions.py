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


MIXED = {
    "document": "handbook.pdf",
    "questions": [
        {"question": "q?", "gold_answers": ["g."]},
        {"question": "r?", "gold_answers": ["h."], "document": "annex.pdf"},
    ],
}


def test_a_set_read_in_code_may_name_several_documents():
    questions = load_questions(MIXED)["questions"]
    assert [q["document"] for q in questions] == ["handbook.pdf", "annex.pdf"]


def test_an_uploaded_set_still_covers_one_document():
    from pandion.evaluation import parse_question_set

    with pytest.raises(QuestionSetError, match="A set covers one document for now, so put annex.pdf's questions"):
        parse_question_set(json.dumps(MIXED).encode(), "q.json")


# --- limits, and files that would crash a parser ---------------------------------


def test_a_set_can_be_capped_in_questions_and_gold_passages():
    from pandion.evaluation import parse_question_set

    many = json.dumps([{"question": f"Q{n}?", "gold_answers": ["g"]} for n in range(3)]).encode()
    parse_question_set(many, max_questions=3)
    with pytest.raises(QuestionSetError, match="3 questions; at most 2"):
        parse_question_set(many, max_questions=2)
    golds = json.dumps([{"question": "Q?", "gold_answers": ["a", "b", "c"]}]).encode()
    parse_question_set(golds, max_golds=3)
    with pytest.raises(QuestionSetError, match="question 1: 3 gold passages; at most 2"):
        parse_question_set(golds, max_golds=2)


def test_a_csv_field_past_the_csv_limit_is_a_plain_error():
    import csv

    from pandion.evaluation import parse_question_set

    huge = "question,gold_answers\nQ?," + '"' + "x" * (csv.field_size_limit() + 1) + '"\n'
    with pytest.raises(QuestionSetError, match="CSV"):
        parse_question_set(huge.encode(), "q.csv")


def test_deeply_nested_json_is_a_plain_error():
    from pandion.evaluation import parse_question_set

    with pytest.raises(QuestionSetError, match="nested"):
        parse_question_set(b"[" * 100_000 + b"]" * 100_000)
