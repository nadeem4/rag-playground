"""A question set kept against its document, checked against the document's text."""

import json

from apihelpers import make_client, upload
from pandion_api import Policy

PASSAGE = "The capital of France is Paris."


def post_set(client, sha, questions, filename="q.json"):
    blob = json.dumps(questions).encode("utf-8")
    return client.post(f"/documents/{sha}/questions", files={"file": (filename, blob, "application/json")})


def test_a_set_is_checked_kept_read_back_and_removed(client, tmp_path):
    sha = upload(client)["sha"]
    r = post_set(client, sha, [{"id": "capital", "question": "Capital?", "gold_answers": [PASSAGE]}])
    body = r.json()
    assert r.status_code == 200 and body["stored"] is True and body["note"] == ""
    assert body["parser"] == "pdfium" and "pdfium" in body["parser_note"]
    assert body["summary"] == {"questions": 1, "found": 1, "found_normalized": 0, "not_found": 0}
    assert (tmp_path / "data" / "sources" / "questions" / f"{sha}.json").is_file()
    assert client.get(f"/documents/{sha}/questions").json()["count"] == 1
    assert client.delete(f"/documents/{sha}/questions").status_code == 204
    assert client.get(f"/documents/{sha}/questions").json() is None
    assert client.delete(f"/documents/{sha}/questions").status_code == 204


def test_a_passage_that_is_not_in_the_document_is_reported_and_the_set_still_kept(client):
    sha = upload(client)["sha"]
    body = post_set(client, sha, [{"question": "Q?", "gold_answers": ["Nothing like this is in it."]}]).json()
    assert body["summary"]["not_found"] == 1 and body["stored"] is True


def test_a_bad_set_is_400_with_its_sentence(client):
    sha = upload(client)["sha"]
    r = post_set(client, sha, [{"question": "", "gold_answers": [PASSAGE]}])
    assert r.status_code == 400 and r.json()["detail"]


def test_a_document_that_is_not_a_pdf_is_415(client):
    sha = client.post("/documents", files={"file": ("a.txt", b"hello there", "text/plain")}).json()["sha"]
    assert post_set(client, sha, [{"question": "Q?", "gold_answers": ["hello there"]}]).status_code == 415


def test_a_word_document_is_415_because_pdfium_cannot_read_it(client):
    sha = client.post(
        "/documents", files={"file": ("notes.docx", b"PK not really a word file", "application/octet-stream")}
    ).json()["sha"]
    r = post_set(client, sha, [{"question": "Q?", "gold_answers": ["hello there"]}])
    assert r.status_code == 415


def test_an_unknown_or_hidden_document_is_404(tmp_path):
    class Hidden(Policy):
        def can_read(self, sha, request):
            return False

    with make_client(tmp_path, Hidden()) as c:
        sha = upload(c)["sha"]
        assert c.get(f"/documents/{sha}/questions").status_code == 404
        assert post_set(c, sha, [{"question": "Q?", "gold_answers": [PASSAGE]}]).status_code == 404
        assert c.get(f"/documents/{'0' * 64}/questions").status_code == 404


def test_a_policy_can_check_a_set_without_keeping_it(tmp_path):
    class Keepless(Policy):
        not_keeping_note = "Checked, not kept."

        def keeps_question_sets(self, request):
            return False

    with make_client(tmp_path, Keepless()) as c:
        sha = upload(c)["sha"]
        body = post_set(c, sha, [{"question": "Capital?", "gold_answers": [PASSAGE]}]).json()
        assert body["stored"] is False and body["note"] == "Checked, not kept."
        assert body["summary"]["found"] == 1
        assert c.get(f"/documents/{sha}/questions").json() is None
    assert not (tmp_path / "data" / "sources" / "questions").exists()


def test_find_gold_places_a_passage_by_the_eval_steps_rule(client):
    pieces = ["Nothing here.", "the capital of france is “paris.”", PASSAGE]
    r = client.post("/golds/find", json={"golds": ['The capital of France is "Paris."'], "texts": pieces})
    assert r.status_code == 200
    assert r.json() == {"found": {"index": 1, "gold": 'The capital of France is "Paris."', "match": "normalized"}}


def test_find_gold_says_null_when_no_piece_holds_one(client):
    assert client.post("/golds/find", json={"golds": [PASSAGE], "texts": ["Lyon."]}).json() == {"found": None}
    assert client.post("/golds/find", json={"golds": [PASSAGE], "texts": []}).json() == {"found": None}


def test_find_gold_refuses_what_it_does_not_look_through(client):
    assert client.post("/golds/find", json={"golds": [], "texts": ["x"]}).status_code == 422
    assert client.post("/golds/find", json={"golds": ["x"], "texts": ["y"] * 101}).status_code == 422
    assert client.post("/golds/find", json={"golds": ["x" * 10_001], "texts": []}).status_code == 422
    assert client.post("/golds/find", json={"golds": ["x"], "texts": ["y" * 500_000, "y" * 500_001]}).status_code == 422


def test_find_gold_caps_keep_one_call_small(client):
    """The caps bound one call's work: 20 passages of at most 10,000 characters,
    and 100 pieces of at most 1,000,000 characters together. One long piece
    is looked through whole."""
    from pandion_api.routes.questions import MAX_GOLDS, MAX_PIECES, MAX_TEXT_CHARS, MAX_TOTAL_CHARS

    assert (MAX_GOLDS, MAX_PIECES, MAX_TEXT_CHARS, MAX_TOTAL_CHARS) == (20, 100, 10_000, 1_000_000)
    body = {"golds": ["g" * MAX_TEXT_CHARS] * MAX_GOLDS, "texts": ["t" * 10_000] * MAX_PIECES}
    assert client.post("/golds/find", json=body).json() == {"found": None}
    long = "t" * 900_000 + " the gold passage"
    found = client.post("/golds/find", json={"golds": ["the gold passage"], "texts": [long]}).json()["found"]
    assert found == {"index": 0, "gold": "the gold passage", "match": "exact"}
