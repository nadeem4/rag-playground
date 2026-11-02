"""The gate by category: a regression in one category fails the run, whatever the total does."""

from __future__ import annotations

from pandion.evaluation import EvaluationReport, QuestionResult, category_of


def q(id: str, found: bool, category: str | None = None) -> QuestionResult:
    return QuestionResult(
        id=id, question=f"What is {id}?", golds=[f"{id} is a thing."],
        tags=[f"category:{category}"] if category else [],
        found=found, rank=1 if found else None, lost_at=None if found else "search", trace=None, score={},
    )


def report(*questions: QuestionResult) -> EvaluationReport:
    return EvaluationReport(top_k=5, questions=list(questions))


def test_category_comes_from_the_category_tag():
    assert category_of({"tags": ["fact", "category:billing"]}) == "billing"


def test_no_category_tag_is_uncategorized():
    assert category_of({"tags": ["fact"]}) == "uncategorized"
    assert category_of({}) == "uncategorized"


def test_results_are_split_by_category():
    before = report(q("a1", True, "a"), q("a2", True, "a"), q("b1", True, "b"), q("b2", False, "b"))
    now = report(q("a1", True, "a"), q("a2", False, "a"), q("b1", True, "b"), q("b2", True, "b"))
    r = now.against(before)
    assert r.by_category["a"] == {
        "compared": 2, "found_before": 2, "found_now": 1, "newly_missed": ["a2"], "newly_found": [],
    }
    assert r.by_category["b"]["newly_found"] == ["b2"]
    assert r.by_category["b"]["newly_missed"] == []


def test_a_category_regression_fails_even_when_the_total_improves():
    before = report(q("a1", True, "a"), q("b1", False, "b"), q("b2", False, "b"))
    now = report(q("a1", False, "a"), q("b1", True, "b"), q("b2", True, "b"))
    r = now.against(before)
    assert r.found_now > r.found_before
    assert not r.gate_ok()
    assert r.failed_categories() == ["a"]


def test_allow_counts_per_category():
    before = report(q("a1", True, "a"), q("a2", True, "a"), q("b1", True, "b"))
    now = report(q("a1", False, "a"), q("a2", True, "a"), q("b1", False, "b"))
    r = now.against(before)
    assert not r.gate_ok(0)
    assert r.gate_ok(1)  # one missed in each category is within 1 per category
    assert not r.ok(1)  # the whole-set count is unchanged: two newly missed


def test_a_newly_found_question_never_fails_the_gate():
    r = report(q("a1", True, "a")).against(report(q("a1", False, "a")))
    assert r.gate_ok() and r.failed_categories() == []


def test_a_small_category_gets_a_weak_gate_note():
    r = report(q("a1", True, "tiny")).against(report(q("a1", True, "tiny")))
    assert 'The "tiny" category has 1 questions, so its gate is weak.' in r.notes


def test_ten_questions_is_not_weak():
    qs = [q(f"a{i}", True, "big") for i in range(10)]
    r = report(*qs).against(report(*qs))
    assert not any("gate is weak" in n for n in r.notes)


def test_an_old_baseline_dict_still_compares():
    now = report(q("a1", True, "a"))
    old = {"top_k": 5, "questions": [
        {"id": "a1", "question": "What is a1?", "golds": ["a1 is a thing."], "found": True, "error": None,
         "tags": ["category:a"]},
    ]}
    r = now.against(old)
    assert r.by_category["a"]["compared"] == 1 and r.gate_ok()


def test_regression_to_dict_keeps_its_old_keys():
    d = report(q("a1", True)).against(report(q("a1", True))).to_dict()
    for key in ("found_before", "found_now", "compared", "newly_missed", "newly_found",
                "unmatched", "partial", "notes", "ok"):
        assert key in d
    assert d["gate_ok"] is True and "uncategorized" in d["by_category"]
