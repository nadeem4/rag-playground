"""I-30 and I-31: bring your own gold set.

Three things are under test: the file format (one parser, two file shapes, and
forgiving where it costs nothing), the template (two filled-in examples about
the bundled sample), and the routes that store a set against a document's
fingerprint and report, per question, whether each gold passage is really in
that document.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pytest

from api.questions import QuestionSetError, parse_question_set
from tests.plugins.conftest import build_pdf

# The fixture document. Page one carries an apostrophe, which the PDF's own
# encoding hands back as a curly one: exactly the case a set typed in a plain
# editor gets wrong.
PAGES = [
    [
        "The reader's eye stops at the boundary.",
        "A chunk should answer one question well.",
    ],
    [
        "Recall at ten is the headline metric.",
        "The evaluation set contains twenty questions.",
    ],
]

#: As the parser reads it, curly apostrophe and all.
BOUNDARY = "The reader’s eye stops at the boundary."
RULE = "A chunk should answer one question well."
RECALL = "Recall at ten is the headline metric."


def upload_doc(client, name: str = "primer.pdf") -> dict:
    r = client.post(
        "/api/sources", files={"file": (name, build_pdf(PAGES), "application/pdf")}
    )
    assert r.status_code == 200, r.text
    return r.json()


def post_set(client, sha: str, content: str | bytes, filename: str = "q.json"):
    blob = content.encode("utf-8") if isinstance(content, str) else content
    return client.post(
        f"/api/sources/{sha}/questions",
        files={"file": (filename, blob, "application/octet-stream")},
    )


def one_json(gold: str, question: str = "Where does the eye stop?") -> str:
    return json.dumps([{"question": question, "gold_answers": [gold]}])


# ---------------------------------------------------------------------------
# I-30: the file format
# ---------------------------------------------------------------------------


def test_a_bare_json_list_is_a_question_set():
    out = parse_question_set(one_json(BOUNDARY).encode(), "q.json")
    assert out["format"] == "json"
    assert out["questions"] == [
        {
            "id": "",
            "question": "Where does the eye stop?",
            "gold_answers": [BOUNDARY],
            "answer": "",
            "tags": [],
            "document": "",
        }
    ]


def test_a_json_object_carries_a_version_and_a_document():
    blob = json.dumps(
        {
            "version": 1,
            "document": "handbook.pdf",
            "questions": [{"question": "q?", "gold_answers": ["g."]}],
        }
    )
    out = parse_question_set(blob.encode(), "q.json")
    assert out["version"] == 1
    assert out["document"] == "handbook.pdf"
    assert len(out["questions"]) == 1


def test_every_optional_field_survives_the_parse():
    blob = json.dumps(
        [
            {
                "id": "refunds",
                "question": "How long do refunds take?",
                "gold_answers": ["Ten working days.", "Within ten working days."],
                "answer": "Ten working days.",
                "tags": ["policy", "money"],
                "document": "handbook.pdf",
            }
        ]
    )
    assert parse_question_set(blob.encode(), "q.json")["questions"][0] == {
        "id": "refunds",
        "question": "How long do refunds take?",
        "gold_answers": ["Ten working days.", "Within ten working days."],
        "answer": "Ten working days.",
        "tags": ["policy", "money"],
        "document": "handbook.pdf",
    }


def test_a_single_gold_answer_string_is_accepted():
    """`gold_answer` instead of `gold_answers`, and a string instead of a list."""
    a = parse_question_set(json.dumps([{"question": "q?", "gold_answer": "g."}]).encode(), "")
    b = parse_question_set(json.dumps([{"question": "q?", "gold_answers": "g."}]).encode(), "")
    assert a["questions"][0]["gold_answers"] == ["g."]
    assert b["questions"] == a["questions"]


def test_csv_reads_the_same_structure_as_json():
    blob = (
        "id,question,gold_answers,answer,tags\n"
        'refunds,How long do refunds take?,"Ten working days. || Within ten '
        'working days.",Ten working days.,"policy, money"\n'
    )
    out = parse_question_set(blob.encode(), "q.csv")
    assert out["format"] == "csv"
    assert out["questions"] == [
        {
            "id": "refunds",
            "question": "How long do refunds take?",
            "gold_answers": ["Ten working days.", "Within ten working days."],
            "answer": "Ten working days.",
            "tags": ["policy", "money"],
            "document": "",
        }
    ]


def test_csv_accepts_a_gold_answer_column_too():
    blob = "question,gold_answer\nq?,g.\n"
    assert parse_question_set(blob.encode(), "q.csv")["questions"][0]["gold_answers"] == ["g."]


def test_whitespace_around_every_value_is_trimmed():
    blob = 'id,question,gold_answers,tags\n  a  ,  q?  ,  g.  ,"  x , y "\n'
    assert parse_question_set(blob.encode(), "q.csv")["questions"][0] == {
        "id": "a",
        "question": "q?",
        "gold_answers": ["g."],
        "answer": "",
        "tags": ["x", "y"],
        "document": "",
    }


def test_blank_rows_are_skipped():
    blob = "question,gold_answers\nq1?,g1.\n\n,,\nq2?,g2.\n\n"
    out = parse_question_set(blob.encode(), "q.csv")
    assert [q["question"] for q in out["questions"]] == ["q1?", "q2?"]


def test_a_byte_order_mark_from_excel_is_not_part_of_the_first_column():
    blob = "﻿question,gold_answers\nq?,g.\n".encode("utf-8")
    assert parse_question_set(blob, "q.csv")["questions"][0]["question"] == "q?"


def test_the_format_is_read_from_the_content_not_the_name():
    """A CSV saved as .json, or the other way round, still parses."""
    assert parse_question_set(b"question,gold_answers\nq?,g.\n", "q.json")["format"] == "csv"
    assert parse_question_set(one_json("g.").encode(), "q.csv")["format"] == "json"


def test_a_question_with_no_text_is_rejected_naming_the_row():
    with pytest.raises(QuestionSetError) as exc:
        parse_question_set(b"question,gold_answers\nq1?,g1.\n,g2.\n", "q.csv")
    assert "row 3" in str(exc.value)
    assert "question" in str(exc.value).lower()


def test_a_question_with_no_gold_passage_is_rejected_naming_the_row():
    blob = json.dumps([{"question": "a?", "gold_answers": ["g."]}, {"question": "b?"}])
    with pytest.raises(QuestionSetError) as exc:
        parse_question_set(blob.encode(), "q.json")
    assert "question 2" in str(exc.value)
    assert "gold" in str(exc.value).lower()


def test_a_file_with_no_questions_is_rejected():
    for blob in (b"[]", b"", b"question,gold_answers\n"):
        with pytest.raises(QuestionSetError):
            parse_question_set(blob, "q.json")


def test_a_csv_with_no_question_column_is_rejected():
    with pytest.raises(QuestionSetError) as exc:
        parse_question_set(b"id,answer\na,b\n", "q.csv")
    assert "question" in str(exc.value)


def test_invalid_json_says_so():
    with pytest.raises(QuestionSetError) as exc:
        parse_question_set(b'{"questions": [', "q.json")
    assert "json" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# I-31: the template
# ---------------------------------------------------------------------------


def test_the_json_template_has_two_examples_with_every_optional_field(client):
    r = client.get("/api/questions/template", params={"format": "json"})
    assert r.status_code == 200
    body = json.loads(r.text)
    assert body["version"] == 1
    assert len(body["questions"]) == 2
    for item in body["questions"]:
        assert set(item) >= {"id", "question", "gold_answers", "answer", "tags"}
        assert item["question"] and item["gold_answers"] and item["tags"]
    # one example shows several gold answers, because that is the easy thing to miss
    assert any(len(q["gold_answers"]) > 1 for q in body["questions"])


def test_the_csv_template_has_the_same_two_examples(client):
    rows = list(
        csv.DictReader(
            io.StringIO(client.get("/api/questions/template", params={"format": "csv"}).text)
        )
    )
    assert [r for r in rows][0].keys() >= {"id", "question", "gold_answers", "answer", "tags"}
    assert len(rows) == 2
    json_body = json.loads(client.get("/api/questions/template", params={"format": "json"}).text)
    assert [r["question"] for r in rows] == [q["question"] for q in json_body["questions"]]
    assert rows[1]["gold_answers"].count("||") == 1


def test_the_template_downloads_under_a_sensible_name(client):
    for fmt in ("json", "csv"):
        r = client.get("/api/questions/template", params={"format": fmt})
        assert f"questions-template.{fmt}" in r.headers["content-disposition"]


def test_the_template_defaults_to_json_and_rejects_anything_else(client):
    assert client.get("/api/questions/template").headers["content-type"].startswith(
        "application/json"
    )
    assert client.get("/api/questions/template", params={"format": "xlsx"}).status_code == 422


def test_the_template_examples_are_about_the_bundled_sample(client):
    """Real questions with real gold sentences, so the file is worth copying."""
    body = json.loads(client.get("/api/questions/template", params={"format": "json"}).text)
    committed = json.loads(
        (Path(__file__).resolve().parents[2] / "samples" / "questions.json").read_text(
            encoding="utf-8"
        )
    )
    golds = {item["gold_answer"] for item in committed}
    for question in body["questions"]:
        assert set(question["gold_answers"]) <= golds, question["id"]
    assert body["document"] == "chunking-primer.pdf"


def test_the_template_parses_back_as_a_question_set(client):
    for fmt in ("json", "csv"):
        text = client.get("/api/questions/template", params={"format": fmt}).text
        out = parse_question_set(text.encode(), f"t.{fmt}")
        assert len(out["questions"]) == 2


# ---------------------------------------------------------------------------
# I-31: storage
# ---------------------------------------------------------------------------


def test_a_set_is_stored_against_the_document_and_read_back(client, dirs):
    sha = upload_doc(client)["sha"]
    r = post_set(client, sha, one_json(BOUNDARY), "mine.json")
    assert r.status_code == 200, r.text
    assert r.json()["stored"] is True
    assert (dirs["sources"] / "questions" / f"{sha}.json").is_file()

    got = client.get(f"/api/sources/{sha}/questions")
    assert got.status_code == 200
    assert got.json() == {
        "sha": sha,
        "filename": "mine.json",
        "format": "json",
        "count": 1,
        "set": r.json()["set"],
    }


def test_no_set_yet_is_a_404(client):
    sha = upload_doc(client)["sha"]
    assert client.get(f"/api/sources/{sha}/questions").status_code == 404


def test_a_set_can_be_removed(client, dirs):
    sha = upload_doc(client)["sha"]
    post_set(client, sha, one_json(BOUNDARY))
    assert client.delete(f"/api/sources/{sha}/questions").status_code == 204
    assert client.get(f"/api/sources/{sha}/questions").status_code == 404
    assert not (dirs["sources"] / "questions" / f"{sha}.json").exists()
    # removing what is not there is not an error
    assert client.delete(f"/api/sources/{sha}/questions").status_code == 204


def test_a_second_upload_replaces_the_first(client):
    sha = upload_doc(client)["sha"]
    post_set(client, sha, one_json(BOUNDARY), "old.json")
    post_set(client, sha, one_json(RULE), "new.json")
    got = client.get(f"/api/sources/{sha}/questions").json()
    assert got["filename"] == "new.json"
    assert got["set"]["questions"][0]["gold_answers"] == [RULE]


def test_a_set_cannot_be_stored_against_an_unknown_document(client):
    assert post_set(client, "0" * 64, one_json(BOUNDARY)).status_code == 404
    assert client.get(f"/api/sources/{'0' * 64}/questions").status_code == 404


def test_an_unreadable_file_is_a_400_naming_the_row(client):
    sha = upload_doc(client)["sha"]
    r = post_set(client, sha, "question,gold_answers\nq1?,g1.\n,g2.\n", "q.csv")
    assert r.status_code == 400
    assert "row 3" in r.json()["detail"]
    assert client.get(f"/api/sources/{sha}/questions").status_code == 404


def test_demo_mode_checks_a_set_but_keeps_nothing(client, dirs, monkeypatch):
    """A visitor can try their own questions; the server just does not keep them."""
    client.post("/api/sources/sample")
    from api import demo

    sha = demo.sample_sha()
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    r = post_set(client, sha, one_json(BOUNDARY))
    assert r.status_code == 200
    body = r.json()
    assert body["stored"] is False
    assert "demo" in body["note"].lower()
    # The check still ran, so the visitor learns whether their passages are real.
    # This passage belongs to another document, so honestly it is not found.
    assert body["summary"] == {"questions": 1, "found": 0, "found_normalized": 0, "not_found": 1}
    assert body["questions"][0]["status"] == "not_found"
    assert not (dirs["sources"] / "questions").exists()
    # And nothing is served back afterwards.
    assert client.get(f"/api/sources/{sha}/questions").status_code == 404


def test_demo_mode_serves_no_set_for_another_document(client, monkeypatch):
    sha = upload_doc(client)["sha"]
    post_set(client, sha, one_json(BOUNDARY))
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert client.get(f"/api/sources/{sha}/questions").status_code == 404


# ---------------------------------------------------------------------------
# I-31: the upload check
# ---------------------------------------------------------------------------


def check(client, content, filename="q.json") -> dict:
    sha = upload_doc(client)["sha"]
    r = post_set(client, sha, content, filename)
    assert r.status_code == 200, r.text
    return r.json()


def test_a_gold_passage_copied_from_the_document_is_found(client):
    body = check(client, one_json(RULE))
    assert body["summary"] == {
        "questions": 1,
        "found": 1,
        "found_normalized": 0,
        "not_found": 0,
    }
    row = body["questions"][0]
    assert row["status"] == "found"
    assert row["golds"][0] == {
        "gold": RULE,
        "status": "found",
        "document_text": "",
        "closest": "",
    }


def test_a_passage_retyped_with_other_quotes_is_found_normalized(client):
    retyped = "The reader's  eye stops at the boundary."
    body = check(client, one_json(retyped))
    row = body["questions"][0]
    assert row["status"] == "found_normalized"
    # the document's own wording comes back, so the file can be fixed
    assert row["golds"][0]["document_text"] == BOUNDARY
    assert body["summary"]["found_normalized"] == 1


def test_a_passage_broken_across_a_line_is_found_normalized(client):
    body = check(client, one_json("Recall at ten is the head-\nline metric."))
    assert body["questions"][0]["status"] == "found_normalized"
    assert body["questions"][0]["golds"][0]["document_text"] == RECALL


def test_a_typo_is_not_found_and_the_closest_passage_shows_why(client):
    typo = "Recall at ten is the headline metirc."
    body = check(client, one_json(typo))
    row = body["questions"][0]
    assert row["status"] == "not_found"
    assert row["golds"][0]["closest"] == RECALL
    assert body["summary"]["not_found"] == 1


def test_a_passage_from_another_document_has_no_close_match(client):
    body = check(client, one_json("Refunds are returned within ten working days."))
    assert body["questions"][0]["status"] == "not_found"
    assert body["questions"][0]["golds"][0]["closest"] == ""


def test_a_set_with_a_missing_passage_is_still_stored(client):
    """A partly good set is still useful; forcing a fix first would be worse."""
    sha = upload_doc(client)["sha"]
    blob = json.dumps(
        [
            {"question": "a?", "gold_answers": [RULE]},
            {"question": "b?", "gold_answers": ["Nothing like this is in there."]},
        ]
    )
    r = post_set(client, sha, blob)
    assert r.status_code == 200
    assert r.json()["stored"] is True
    assert [q["status"] for q in r.json()["questions"]] == ["found", "not_found"]
    assert client.get(f"/api/sources/{sha}/questions").json()["count"] == 2


def test_a_question_is_only_found_when_all_of_its_golds_are(client):
    blob = json.dumps([{"question": "a?", "gold_answers": [RULE, "Not in there."]}])
    row = check(client, blob)["questions"][0]
    assert [g["status"] for g in row["golds"]] == ["found", "not_found"]
    assert row["status"] == "not_found"


def test_the_report_says_which_parser_read_the_document(client):
    body = check(client, one_json(RULE))
    assert body["parser"] == "pdfium"
    assert "pdfium" in body["parser_note"]
    assert "parser" in body["parser_note"]


def test_the_report_carries_the_question_and_its_id(client):
    blob = json.dumps([{"id": "rule", "question": "How big?", "gold_answers": [RULE]}])
    row = check(client, blob)["questions"][0]
    assert row["id"] == "rule"
    assert row["question"] == "How big?"
    assert row["index"] == 0


def test_a_source_that_is_not_a_pdf_says_so(client):
    r = client.post(
        "/api/sources", files={"file": ("notes.txt", b"hello there", "text/plain")}
    )
    got = post_set(client, r.json()["sha"], one_json("hello there"), "q.json")
    assert got.status_code == 415
