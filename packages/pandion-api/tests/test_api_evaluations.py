"""POST /evaluations and POST /comparisons: part 2's features, as runs."""

import json

import pytest
from fastapi import HTTPException

from apihelpers import PIPELINE, finish, make_client, upload
from pandion_api import Policy
from pandion_api.routes.ask import NO_ANSWER
from pandion_api.routes.evaluations import ANSWER_NEEDS_QUESTION, NO_THROUGH_WITH_QUESTION, ONE_OR_THE_OTHER

QUESTIONS = [
    {"id": "capital", "question": "What is the capital of France?", "gold_answers": ["The capital of France is Paris."]}
]
VARIANTS = [
    {"use": "recursive_character", "chunk_size": 70},
    {"use": "recursive_character", "chunk_size": 200},
]


def test_an_evaluation_reports_each_question_and_the_totals(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "documents": [sha], "questions": QUESTIONS, "top_k": 3}
    state, events = finish(client, client.post("/evaluations", json=body))
    result = state["result"]
    assert state["kind"] == "evaluation" and state["ok"] is True
    assert result["top_k"] == 3 and result["total"] == 1 and result["cancelled"] is False
    assert result["questions"][0]["id"] == "capital" and "found" in result["questions"][0]
    assert any(e["event"] == "question_finished" for e in events)


def test_a_bad_question_set_is_400_before_anything_runs(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "documents": [sha], "questions": [{"question": "No gold passage?"}]}
    r = client.post("/evaluations", json=body)
    assert r.status_code == 400 and r.json()["detail"]


def test_a_pipeline_without_a_search_step_cannot_be_evaluated(client):
    sha = upload(client)["sha"]
    body = {"config": {"index": PIPELINE["index"]}, "documents": [sha], "questions": QUESTIONS}
    assert client.post("/evaluations", json=body).status_code == 422


def test_without_questions_the_documents_kept_set_is_used(client):
    sha = upload(client)["sha"]
    kept = json.dumps({"questions": QUESTIONS}).encode()
    assert client.post(f"/documents/{sha}/questions", files={"file": ("q.json", kept, "application/json")}).status_code == 200
    state, _ = finish(client, client.post("/evaluations", json={"config": PIPELINE, "documents": [sha]}))
    assert state["ok"] is True and [q["id"] for q in state["result"]["questions"]] == ["capital"]


def test_without_questions_and_no_kept_set_an_evaluation_is_400(client):
    sha = upload(client)["sha"]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha]})
    assert r.status_code == 400 and "question" in r.json()["detail"]


def test_a_question_set_in_the_request_is_capped_like_an_upload(client):
    sha = upload(client)["sha"]
    many = [{"question": f"Question {n}?", "gold_answers": ["Paris."]} for n in range(501)]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": many})
    assert r.status_code == 400 and "500" in r.json()["detail"]
    golds = [{"question": "Where?", "gold_answers": [f"Passage {n}." for n in range(21)]}]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": golds})
    assert r.status_code == 400 and "20" in r.json()["detail"]
    huge = [{"question": "Where?", "gold_answers": ["x" * (1024 * 1024)]}]
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": huge})
    assert r.status_code == 413


def test_a_comparison_runs_each_variant_and_names_the_best(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "questions": QUESTIONS}
    state, _ = finish(client, client.post("/comparisons", json=body))
    result = state["result"]
    assert state["kind"] == "comparison" and state["ok"] is True
    assert len(result["comparisons"]) == 2 and isinstance(result["best"], list)
    assert [c["variant"]["chunk_size"] for c in result["comparisons"]] == [70, 200]


def test_a_comparison_without_questions_gives_each_variants_step(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
    state, _ = finish(client, client.post("/comparisons", json=body))
    assert [c["ok"] for c in state["result"]["comparisons"]] == [True, True]


def test_what_cannot_be_compared_is_400_before_anything_runs(client):
    sha = upload(client)["sha"]
    base = {"config": PIPELINE, "variants": VARIANTS, "documents": [sha]}
    assert client.post("/comparisons", json={**base, "stage": "answer"}).status_code == 400
    search = {**base, "stage": "search", "variants": [{"use": "dense"}, {"use": "bm25"}]}
    r = client.post("/comparisons", json=search)
    assert r.status_code == 400 and "questions" in r.json()["detail"]
    assert client.post("/comparisons", json={**base, "stage": "chunk", "variants": VARIANTS * 6}).status_code == 422


def test_the_policy_sets_how_many_variants_one_comparison_may_have(tmp_path):
    class Two(Policy):
        def max_variants(self, request):
            return 2

    with make_client(tmp_path, Two()) as c:
        sha = upload(c)["sha"]
        body = {"config": PIPELINE, "stage": "chunk", "variants": [*VARIANTS, VARIANTS[0]], "documents": [sha]}
        r = c.post("/comparisons", json=body)
    assert r.status_code == 422 and "at most 2" in r.json()["detail"]["problems"][0]


def test_a_variant_the_policy_refuses_is_refused_before_anything_runs(tmp_path):
    class NoBigPieces(Policy):
        def check_run(self, config, request):
            if config["index"]["chunk"].get("chunk_size", 0) > 100:
                raise HTTPException(403, "Pieces stay small here.")

    with make_client(tmp_path, NoBigPieces()) as c:
        sha = upload(c)["sha"]
        body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
        r = c.post("/comparisons", json=body)
    assert r.status_code == 403 and r.json()["detail"] == "Pieces stay small here."


def keep(client, sha, questions):
    data = json.dumps({"questions": questions}).encode()
    r = client.post(f"/documents/{sha}/questions", files={"file": ("q.json", data, "application/json")})
    assert r.status_code == 200, r.text


def test_a_comparison_without_questions_is_index_only_even_with_a_kept_set(client):
    sha = upload(client)["sha"]
    keep(client, sha, QUESTIONS)
    body = {"config": {"index": PIPELINE["index"]}, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
    state, _ = finish(client, client.post("/comparisons", json=body))
    assert state["ok"] is True and [c["report"] for c in state["result"]["comparisons"]] == [None, None]


def test_a_comparison_with_questions_needs_a_search_step(client):
    sha = upload(client)["sha"]
    body = {"config": {"index": PIPELINE["index"]}, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "questions": QUESTIONS}
    r = client.post("/comparisons", json=body)
    assert r.status_code == 422
    assert "retrieve" in r.json()["detail"]["problems"][0]


def test_a_comparison_can_stop_each_variant_after_a_step(client):
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "through": "chunk"}
    state, events = finish(client, client.post("/comparisons", json=body))
    assert state["ok"] is True and [c["ok"] for c in state["result"]["comparisons"]] == [True, True]
    assert not any(e.get("step") in ("embed", "store", "index") for e in events if e["event"] == "node_started")


def test_through_with_questions_or_naming_no_step_is_400_before_anything_runs(client):
    sha = upload(client)["sha"]
    base = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
    r = client.post("/comparisons", json={**base, "through": "chunk", "questions": QUESTIONS})
    assert r.status_code == 400 and "through" in r.json()["detail"]
    r = client.post("/comparisons", json={**base, "through": "parse"})
    assert r.status_code == 400 and "before the chunk step" in r.json()["detail"]
    assert client.post("/comparisons", json={**base, "through": "nowhere"}).status_code == 400


def test_a_variant_is_taken_as_compare_takes_it(tmp_path):
    seen: list[dict] = []

    class Recording(Policy):
        def check_run(self, config, request):
            seen.append(config)

    with make_client(tmp_path, Recording()) as c:
        sha = upload(c)["sha"]
        body = {"config": PIPELINE, "stage": "clean", "variants": [{"use": "dedupe_blocks"}, "dedupe_blocks"], "documents": [sha]}
        state, _ = finish(c, c.post("/comparisons", json=body))
    assert state["ok"] is True
    assert [s["index"]["clean"] for s in seen[1:]] == [[{"use": "dedupe_blocks"}]] * 2


def test_kept_sets_from_several_documents_keep_every_question_apart(client):
    first = upload(client)["sha"]
    from pdfs import SAMPLE_PAGES, build_pdf

    second = upload(client, "other.pdf", build_pdf([*SAMPLE_PAGES, ["One more page."]]))["sha"]
    keep(client, first, QUESTIONS)
    keep(client, second, QUESTIONS)
    state, _ = finish(client, client.post("/evaluations", json={"config": PIPELINE, "documents": [first, second]}))
    ids = [q["id"] for q in state["result"]["questions"]]
    assert ids == ["report.pdf: capital", "other.pdf: capital"]


def test_kept_sets_together_hold_at_most_500_questions(client):
    from pdfs import SAMPLE_PAGES, build_pdf

    shas = [upload(client)["sha"], upload(client, "other.pdf", build_pdf([*SAMPLE_PAGES, ["One more page."]]))["sha"]]
    for n, sha in enumerate(shas):
        keep(client, sha, [{"id": f"{n}-{i}", "question": "Where?", "gold_answers": ["Paris."]} for i in range(300)])
    r = client.post("/evaluations", json={"config": PIPELINE, "documents": shas})
    assert r.status_code == 400 and "500" in r.json()["detail"]


def _on_the_loop() -> bool:
    import asyncio

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def test_a_comparison_prepares_its_variants_and_checks_through_off_the_event_loop(client, monkeypatch):
    from pandion_api.routes import evaluations

    seen: list[tuple[str, bool]] = []
    real_prepare, real_compare = evaluations.prepare, evaluations.compare

    def prepare(*args, **kwargs):
        seen.append(("prepare", _on_the_loop()))
        return real_prepare(*args, **kwargs)

    def compare(*args, **kwargs):
        seen.append(("compare", _on_the_loop()))
        return real_compare(*args, **kwargs)

    monkeypatch.setattr(evaluations, "prepare", prepare)
    monkeypatch.setattr(evaluations, "compare", compare)
    sha = upload(client)["sha"]
    body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "through": "chunk"}
    finish(client, client.post("/comparisons", json=body))
    assert [name for name, _ in seen].count("prepare") == 3
    assert "compare" in [name for name, _ in seen]
    assert not any(on_loop for _, on_loop in seen), seen


def test_one_question_without_a_gold_passage_compares_searches(client):
    sha = upload(client)["sha"]
    body = {
        "config": PIPELINE,
        "stage": "search",
        "variants": [{"use": "dense", "top_k": 2}, {"use": "bm25", "top_k": 2}],
        "documents": [sha],
        "question": "What is the capital of France?",
    }
    state, events = finish(client, client.post("/comparisons", json=body))
    result = state["result"]
    assert state["kind"] == "comparison" and state["ok"] is True
    assert [c["variant"]["use"] for c in result["comparisons"]] == ["dense", "bm25"]
    assert all(c["retrieval"]["hits"] for c in result["comparisons"])
    assert result["best"] == []
    step_events = [e for e in events if "step" in e]
    assert {e.get("variant") for e in step_events} == {1, 2}
    assert {e.get("variants") for e in step_events} == {2}


def test_one_question_can_go_through_the_answer(client):
    sha = upload(client)["sha"]
    body = {
        "config": PIPELINE,
        "stage": "chunk",
        "variants": VARIANTS,
        "documents": [sha],
        "question": "What is the capital of France?",
        "answer": True,
    }
    state, _ = finish(client, client.post("/comparisons", json=body))
    assert all("answer" in c and c["answer"]["text"] for c in state["result"]["comparisons"])


def test_question_and_questions_together_are_refused(client):
    sha = upload(client)["sha"]
    body = {
        "config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha],
        "question": "Paris?", "questions": QUESTIONS,
    }
    r = client.post("/comparisons", json=body)
    assert r.status_code == 400 and r.json()["detail"] == ONE_OR_THE_OTHER


def test_one_question_keeps_the_ask_routes_limits(client):
    sha = upload(client)["sha"]
    base = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
    assert client.post("/comparisons", json={**base, "question": "x" * 2001}).status_code == 422
    no_answer = {k: v for k, v in PIPELINE.items() if k != "answer"}
    r = client.post("/comparisons", json={**base, "config": no_answer, "question": "Paris?", "answer": True})
    assert r.status_code == 422 and r.json()["detail"]["problems"] == [NO_ANSWER]


def test_through_with_one_question_is_refused(client):
    sha = upload(client)["sha"]
    body = {
        "config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha],
        "question": "Paris?", "through": "chunk",
    }
    r = client.post("/comparisons", json=body)
    assert r.status_code == 400 and r.json()["detail"] == NO_THROUGH_WITH_QUESTION


def test_answer_without_one_question_is_refused(client):
    sha = upload(client)["sha"]
    for extra in ({}, {"questions": QUESTIONS}):
        body = {
            "config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha],
            "answer": True, **extra,
        }
        r = client.post("/comparisons", json=body)
        assert r.status_code == 400 and r.json()["detail"] == ANSWER_NEEDS_QUESTION


# --- the visitor's key reaches each question-asking run, and is never stored ----------

KEY = "sk-secret-evaluate-123"


class Keyed(Policy):
    def credentials(self, request):
        return {"anthropic_api_key": KEY}


def _spy(monkeypatch, target, name: str, seen: list) -> None:
    """Record each call's credentials, then run the real function."""
    real = getattr(target, name)

    def spy(*args, credentials=None, **kwargs):
        seen.append(credentials)
        return real(*args, credentials=credentials, **kwargs)

    monkeypatch.setattr(target, name, spy)


def _no_key_on_disk(tmp_path) -> None:
    files = [p for p in (tmp_path / "data").rglob("*") if p.is_file()]
    assert files, "the run wrote nothing, so this check would prove nothing"
    assert not [p for p in files if KEY.encode() in p.read_bytes()]


def test_an_evaluation_gets_the_key_and_stores_none_of_it(tmp_path, monkeypatch):
    from pandion_api.routes import evaluations

    seen: list = []
    _spy(monkeypatch, evaluations, "evaluate", seen)
    with make_client(tmp_path, Keyed()) as client:
        sha = upload(client)["sha"]
        state, events = finish(client, client.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": QUESTIONS}))
    assert state["ok"] is True
    assert seen == [{"anthropic_api_key": KEY}]
    assert KEY not in json.dumps([state, events])
    _no_key_on_disk(tmp_path)


def test_a_comparison_gets_the_key_and_stores_none_of_it(tmp_path, monkeypatch):
    from pandion_api.routes import evaluations

    seen: list = []
    _spy(monkeypatch, evaluations, "compare", seen)
    with make_client(tmp_path, Keyed()) as client:
        sha = upload(client)["sha"]
        body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "questions": QUESTIONS}
        state, events = finish(client, client.post("/comparisons", json=body))
    assert state["ok"] is True
    assert seen == [{"anthropic_api_key": KEY}]
    assert KEY not in json.dumps([state, events])
    _no_key_on_disk(tmp_path)


def test_a_comparison_on_one_question_gets_the_key_for_each_variant(tmp_path, monkeypatch):
    from pandion import Pipeline

    seen: list = []
    _spy(monkeypatch, Pipeline, "retrieve", seen)
    with make_client(tmp_path, Keyed()) as client:
        sha = upload(client)["sha"]
        body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha], "question": "Capital?"}
        state, _ = finish(client, client.post("/comparisons", json=body))
    assert state["ok"] is True
    assert seen == [{"anthropic_api_key": KEY}] * len(VARIANTS)
    _no_key_on_disk(tmp_path)


# --- how many questions one run may ask -------------------------------------------


class AtMostTwo(Policy):
    """Two questions an evaluation, and three variant-questions a comparison."""

    def __init__(self):
        self.asked = []

    def check_question_count(self, kind, count, request):
        self.asked.append((kind, count))
        if count > {"evaluation": 2, "comparison": 3}[kind]:
            raise HTTPException(413, f"At most so many, not {count}.")


def test_the_policy_refuses_an_evaluation_that_asks_too_many_questions(tmp_path):
    policy = AtMostTwo()
    with make_client(tmp_path, policy) as c:
        sha = upload(c)["sha"]
        r = c.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": QUESTIONS * 3})
        assert r.status_code == 413 and r.json()["detail"] == "At most so many, not 3."
        # A kept set is counted the same way.
        keep(c, sha, [{**q, "id": f"q{n}"} for n, q in enumerate(QUESTIONS * 3)])
        r = c.post("/evaluations", json={"config": PIPELINE, "documents": [sha]})
        assert r.status_code == 413
        finish(c, c.post("/evaluations", json={"config": PIPELINE, "documents": [sha], "questions": QUESTIONS * 2}))
    assert policy.asked == [("evaluation", 3), ("evaluation", 3), ("evaluation", 2)]


def test_the_policy_refuses_a_comparison_by_its_variants_times_its_questions(tmp_path):
    policy = AtMostTwo()
    with make_client(tmp_path, policy) as c:
        sha = upload(c)["sha"]
        body = {"config": PIPELINE, "stage": "chunk", "variants": VARIANTS, "documents": [sha]}
        r = c.post("/comparisons", json={**body, "questions": QUESTIONS * 2})
        assert r.status_code == 413 and r.json()["detail"] == "At most so many, not 4."
        finish(c, c.post("/comparisons", json={**body, "variants": VARIANTS[:1], "questions": QUESTIONS * 2}))
    assert policy.asked == [("comparison", 4), ("comparison", 2)]


def _run(*found: bool, top_k: int = 5, **kw):
    questions = [{"id": f"q{n}", "question": f"Question {n}?", "found": f, "golds": [f"Gold {n}."]} for n, f in enumerate(found)]
    n = sum(found)
    return {"top_k": top_k, "questions": questions, "scored": len(found), "found": n, "hit_rate": n / len(found), "mrr": n / len(found), **kw}


def test_against_compares_a_run_with_its_baseline_as_the_package_does(client):
    r = client.post("/evaluations/against", json={"report": _run(True, False, True), "baseline": _run(True, True, False)})
    assert r.status_code == 200
    body = r.json()
    assert (body["found_before"], body["found_now"], body["compared"]) == (2, 2, 3)
    assert body["newly_missed"] == ["q1"] and body["newly_found"] == ["q2"]
    assert body["partial"] is False and body["ok"] is False
    assert body["best"] == [0, 1]


def test_against_names_the_better_run_and_says_what_was_not_like_for_like(client):
    body = client.post(
        "/evaluations/against",
        json={"report": _run(True, True, top_k=3, nondeterministic=["llm_rerank"]), "baseline": _run(True, False)},
    ).json()
    assert body["best"] == [1]
    assert body["partial"] is True
    assert any("top 5" in n and "top 3" in n for n in body["notes"])
    assert any("llm_rerank" in n for n in body["notes"])


def test_against_refuses_what_is_not_a_report(client):
    assert client.post("/evaluations/against", json={"report": {"top_k": 5}, "baseline": _run(True)}).status_code == 422
    too_many = _run(*([True] * 501))
    assert client.post("/evaluations/against", json={"report": too_many, "baseline": _run(True)}).status_code == 422


@pytest.mark.parametrize(
    "change",
    [
        lambda q: q.update(question="x" * 2001),
        lambda q: q.update(id="x" * 501),
        lambda q: q.update(error="x" * 10_001),
        lambda q: q.update(golds=["x" * 10_001]),
    ],
)
def test_against_caps_each_text_as_the_other_routes_do(client, change):
    report = _run(True)
    change(report["questions"][0])
    assert client.post("/evaluations/against", json={"report": report, "baseline": _run(True)}).status_code == 422


def test_against_takes_a_long_error_line_so_the_comparison_still_shows(client):
    # A failed step's last line can be a whole HTTP body: the run is still compared.
    report = _run(True, True)
    report["questions"][1]["error"] = "The search step (dense) failed: " + "x" * 5000
    assert client.post("/evaluations/against", json={"report": report, "baseline": _run(True, True)}).status_code == 200


def test_against_caps_the_gold_passages_together_at_a_sets_size(client):
    report = _run(*([True] * 6))
    for q in report["questions"]:
        q["golds"] = ["x" * 10_000] * 20
    r = client.post("/evaluations/against", json={"report": report, "baseline": _run(True)})
    assert r.status_code == 422
    assert "gold passages together" in json.dumps(r.json())


# --- a question scores only in its own document (multi-document part 4) ------------

BEES = {"id": "bees", "question": "How do bees show the way?", "gold_answers": ["Bees dance to show the hive where the flowers are."]}


def _two(client):
    from pdfs import build_pdf

    first = upload(client)["sha"]
    second = upload(client, "bees.pdf", build_pdf([[BEES["gold_answers"][0]], ["Honey keeps for years."]]))["sha"]
    return first, second


def test_an_evaluation_scores_a_named_question_in_its_own_document_and_totals_by_document(client):
    first, second = _two(client)
    questions = [{**BEES, "id": "named", "document": "report.pdf"}, BEES]
    body = {"config": PIPELINE, "documents": [first, second], "questions": questions}
    state, _ = finish(client, client.post("/evaluations", json=body))
    result = state["result"]
    assert [(q["id"], q["found"], q["document"]) for q in result["questions"]] == [
        ("named", False, first), ("bees", True, None),
    ]
    assert [(d["document"], d["total"], d["found"]) for d in result["by_document"]] == [(first, 1, 0), (None, 1, 1)]


def test_a_question_naming_a_document_not_evaluated_is_400_before_anything_runs(client):
    first, second = _two(client)
    body = {"config": PIPELINE, "documents": [first], "questions": [{**BEES, "document": "bees.pdf"}]}
    r = client.post("/evaluations", json=body)
    assert r.status_code == 400
    assert r.json()["detail"] == (
        "Question 1 names the document bees.pdf, which is not one of the documents searched: report.pdf."
    )


def test_a_question_kept_against_a_document_is_scored_in_that_document(client):
    first, second = _two(client)
    keep(client, first, [{**BEES, "document": "whatever-it-was-called.pdf"}])
    state, _ = finish(client, client.post("/evaluations", json={"config": PIPELINE, "documents": [first, second]}))
    q = state["result"]["questions"][0]
    assert (q["found"], q["document"]) == (False, first)


def test_one_kept_set_across_documents_runs_as_one(client):
    first, second = _two(client)
    data = json.dumps([{**BEES, "id": "named", "document": "bees.pdf"}, {**QUESTIONS[0], "id": "any"}]).encode()
    r = client.post("/questions", data={"documents": [first, second]}, files={"file": ("g.json", data, "application/json")})
    assert r.status_code == 200, r.text
    state, _ = finish(client, client.post("/evaluations", json={"config": PIPELINE, "documents": [first, second]}))
    assert [(q["id"], q["found"], q["document"]) for q in state["result"]["questions"]] == [
        ("any", True, None), ("named", True, second),
    ]


def test_an_unnamed_question_kept_with_the_first_document_is_found_in_any_of_them(client):
    first, second = _two(client)
    data = json.dumps([{**BEES, "id": "any"}]).encode()   # its evidence is only in the second document
    r = client.post("/questions", data={"documents": [first, second]}, files={"file": ("g.json", data, "application/json")})
    assert r.status_code == 200, r.text
    assert client.get(f"/documents/{first}/questions").json()["set"]["questions"][0]["document"] == ""
    state, _ = finish(client, client.post("/evaluations", json={"config": PIPELINE, "documents": [first, second]}))
    q = state["result"]["questions"][0]
    assert (q["id"], q["found"], q["document"]) == ("any", True, None)
    assert [(d["document"], d["found"]) for d in state["result"]["by_document"]] == [(None, 1)]
