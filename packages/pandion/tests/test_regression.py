"""report.against(baseline): which questions a run newly missed or newly found.

Most tests build reports by hand. Two run `evaluate` on one small PDF with
the fake embedder, and a fake chat model for llm_rerank, so nothing reaches
the network.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import pandion
from pandion import Pipeline, cli, llm
from pandion.evaluation import EvaluationReport, QuestionResult, Regression
from pandion.llm import Completion
from pdfs import SAMPLE_PAGES, build_pdf


def q(id: str, found: bool, question: str | None = None, golds: list[str] | None = None) -> QuestionResult:
    return QuestionResult(
        id=id, question=question or f"What is {id}?", golds=golds or [f"{id} is a thing."], tags=[],
        found=found, rank=1 if found else None, lost_at=None if found else "search", trace=None, score={},
    )


def report(*questions: QuestionResult, top_k: int = 5, **kw) -> EvaluationReport:
    return EvaluationReport(top_k=top_k, questions=list(questions), **kw)


BEFORE = report(q("q1", True), q("q2", True), q("q3", False), q("q4", True))


def test_newly_missed_and_newly_found_by_id():
    now = report(q("q1", True), q("q2", False), q("q3", True), q("q4", False))
    r = now.against(BEFORE)
    assert isinstance(r, Regression)
    assert (r.found_before, r.found_now) == (3, 2)
    assert r.newly_missed == ["q2", "q4"]
    assert r.newly_found == ["q3"]
    assert r.unmatched == []
    assert not r.partial
    assert not r.ok() and r.ok(allow=2) and not r.ok(allow=1)


def test_questions_without_ids_are_matched_by_their_text():
    before = report(q("question 1", True, "Where is Paris?"), q("question 2", True, "Where is Rome?"))
    now = report(q("question 1", True, "Where is Rome?"), q("question 2", False, "Where is Paris?"))
    r = now.against(before)
    assert r.newly_missed == ["question 2"]
    assert r.newly_found == []


def test_an_errored_question_is_left_out_and_said_so():
    broken = q("q2", False)
    broken.error = "The search step (dense) failed: no key."
    now = report(q("q1", True), broken, q("q3", False), q("q4", True))
    r = now.against(BEFORE)
    assert r.newly_missed == [] and r.unmatched == []
    assert (r.compared, r.found_before, r.found_now) == (3, 2, 2)
    assert "1 question could not be scored and is left out." in r.notes
    other = q("q1", True)
    other.error = broken.error
    assert "2 questions could not be scored and are left out." in BEFORE.against(report(other, broken)).notes


def test_ids_pair_first_so_a_new_id_with_the_same_text_takes_no_partner():
    before = report(q("q1", True, "Where is Paris?"), q("q2", True, "Where is Rome?"))
    now = report(q("new", False, "Where is Paris?"), q("q1", True, "Where is Paris?"), q("q2", True, "Where is Rome?"))
    r = now.against(before)
    assert r.unmatched == ["new"]
    assert r.newly_missed == []


def test_regression_is_public():
    assert pandion.Regression is Regression and "Regression" in pandion.__all__


def test_a_reordered_set_still_matches():
    now = report(q("q4", True), q("q3", False), q("q2", True), q("q1", True))
    r = now.against(BEFORE)
    assert r.newly_missed == [] and r.newly_found == [] and r.unmatched == []
    assert not r.partial
    assert now.to_dict()["questions_fingerprint"] == BEFORE.to_dict()["questions_fingerprint"]


def test_the_fingerprint_ignores_key_order_and_follows_the_gold_passages():
    data = BEFORE.to_dict()
    swapped = report(*(q(x.id, x.found, x.question, list(reversed(x.golds))) for x in BEFORE.questions))
    assert swapped.to_dict()["questions_fingerprint"] == data["questions_fingerprint"]
    changed = report(q("q1", True, golds=["Something else."]), *BEFORE.questions[1:])
    assert changed.to_dict()["questions_fingerprint"] != data["questions_fingerprint"]


def test_a_different_set_compares_only_the_shared_questions_and_says_so():
    now = report(q("q1", False), q("q2", True), q("q5", True))
    r = now.against(BEFORE)
    assert r.partial
    assert r.unmatched == ["q5", "q3", "q4"]
    assert (r.found_before, r.found_now, r.compared) == (2, 1, 2)
    assert r.newly_missed == ["q1"]
    assert "only the 2 questions both runs share are compared" in str(r)


def test_a_different_top_k_says_so():
    r = report(*BEFORE.questions, top_k=3).against(BEFORE)
    assert r.partial
    assert "The baseline checked the top 5 pieces and this run the top 3" in str(r)


def test_the_printed_line():
    now = report(q("q1", True), q("q2", False), q("q3", True), q("q4", False))
    assert str(now.against(BEFORE)).splitlines() == [
        "Found 2 of 4; the baseline found 3 of 4. Newly missed: q2, q4. Newly found: q3.",
    ]
    assert str(BEFORE.against(BEFORE)) == "Found 3 of 4; the baseline found 3 of 4."


def test_the_round_trip_through_a_dict_and_a_file(tmp_path):
    now = report(q("q1", True), q("q2", False), q("q5", True), top_k=3)
    path = tmp_path / "base.json"
    path.write_text(json.dumps(BEFORE.to_dict()), encoding="utf-8")
    assert now.against(BEFORE.to_dict()) == now.against(BEFORE)
    assert now.against(path) == now.against(BEFORE)
    assert now.against(str(path)) == now.against(BEFORE)


def test_a_missing_or_wrong_baseline_is_a_plain_error(tmp_path):
    with pytest.raises(ValueError, match="no baseline file"):
        BEFORE.against(tmp_path / "missing.json")
    (tmp_path / "bad.json").write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(ValueError, match="not an evaluation report"):
        BEFORE.against(tmp_path / "bad.json")


def test_the_warning_shows_when_a_step_is_not_deterministic():
    shaky = report(*BEFORE.questions, nondeterministic=["llm_rerank"])
    assert any("llm_rerank" in note and "noise" in note for note in shaky.against(BEFORE).notes)
    assert "noise" in str(BEFORE.against(shaky))
    assert not any("noise" in note for note in BEFORE.against(BEFORE).notes)


# evaluate fills in what against needs.

FOUND = {"id": "capital", "question": "What is the capital of France?", "gold_answer": "The capital of France is Paris."}


def pipeline(tmp_path, rerank=None):
    return Pipeline(
        path=tmp_path / "index", parse="pdfium",
        chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        embed="fake-deterministic", store="lancedb", search={"use": "bm25", "top_k": 4},
        **({"rerank": rerank} if rerank else {}),
    )


@pytest.fixture
def docs(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "sample.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    return folder


def test_evaluate_records_the_fingerprint_the_document_shas_and_top_k(tmp_path, docs):
    data = pandion.evaluate(pipeline(tmp_path), [FOUND], top_k=3, documents=docs).to_dict()
    assert data["top_k"] == 3
    assert len(data["questions_fingerprint"]) == 64
    assert len(data["document_shas"]) == 1 and len(data["document_shas"][0]) == 64
    assert data["nondeterministic"] == []


def test_evaluate_names_a_step_that_is_not_deterministic(tmp_path, docs, monkeypatch):
    monkeypatch.setattr(llm, "complete", lambda model, **kw: Completion(text="1, 2", usage={}, stop_reason="end_turn"))
    p = pipeline(tmp_path, rerank={"use": "llm_rerank", "top_k": 2})
    shaky = pandion.evaluate(p, [FOUND], documents=docs, credentials={"anthropic_api_key": "sk-ant-test"})
    assert shaky.questions[0].error is None
    assert shaky.nondeterministic == ["llm_rerank"]
    steady = pandion.evaluate(pipeline(tmp_path), [FOUND], documents=docs)
    assert any("noise" in note for note in steady.against(shaky).notes)
    assert not any("noise" in note for note in steady.against(steady).notes)


def test_best_is_the_rule_compare_uses():
    two = report(q("q1", True), q("q2", True))
    one = report(q("q1", True), q("q2", False))
    assert pandion.evaluation.best([one, two]) == [1]
    assert pandion.evaluation.best([two, two]) == [0, 1]
    assert pandion.evaluation.best([report(q("q1", False))]) == []


# pandion eval --baseline base.json [--allow N]

CONFIG = """\
path: ./index
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
retrieve:
  search: {use: dense}
"""

NOW = report(q("q1", True), q("q2", False), q("q3", True), q("q4", False))


@pytest.fixture
def cli_run(tmp_path, monkeypatch, capsys):
    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG, encoding="utf-8")
    base = tmp_path / "base.json"
    base.write_text(json.dumps(BEFORE.to_dict()), encoding="utf-8")
    monkeypatch.setattr(cli.pandion, "evaluate", lambda *a, **kw: NOW)

    def run(*args: str) -> tuple[int, str, str]:
        code = cli.main(["eval", str(config), "q.json", *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    run.base = str(base)
    run.tmp = tmp_path
    return run


def test_eval_with_a_baseline_prints_the_comparison_and_fails_over_allow(cli_run):
    code, out, _ = cli_run("--baseline", cli_run.base)
    assert code == 1
    assert "Found 2 of 4; the baseline found 3 of 4. Newly missed: q2, q4. Newly found: q3." in out.splitlines()


def test_eval_passes_within_allow(cli_run):
    assert cli_run("--baseline", cli_run.base, "--allow", "2")[0] == 0
    assert cli_run("--baseline", cli_run.base, "--allow", "1")[0] == 1


def test_eval_json_holds_the_regression(cli_run):
    code, out, _ = cli_run("--baseline", cli_run.base, "--allow", "2", "--json")
    assert code == 0
    assert json.loads(out)["regression"]["newly_missed"] == ["q2", "q4"]


def test_a_missing_baseline_is_a_plain_error_before_anything_runs(cli_run, monkeypatch):
    monkeypatch.setattr(cli.pandion, "evaluate", lambda *a, **kw: pytest.fail("evaluate ran"))
    missing = str(cli_run.tmp / "missing.json")
    code, _, err = cli_run("--baseline", missing)
    assert code == 2
    assert err.strip() == f"pandion: There is no baseline file at {missing}. Save one with pandion eval ... --json > {missing}."


def test_the_baseline_is_read_once_before_the_run(cli_run, monkeypatch):
    def evaluate(*a, **kw):
        Path(cli_run.base).unlink()  # gone by the time the run ends
        return NOW

    monkeypatch.setattr(cli.pandion, "evaluate", evaluate)
    code, out, _ = cli_run("--baseline", cli_run.base, "--allow", "2")
    assert code == 0 and "Newly missed: q2, q4." in out


def test_allow_needs_a_baseline(cli_run):
    code, _, err = cli_run("--allow", "1")
    assert code == 2 and "--allow" in err


# --------------------------------------------------------------------------
# regression(now, baseline) and best() on plain dicts, as pandion-api serves them
# --------------------------------------------------------------------------


def _slim(r: EvaluationReport) -> dict:
    """Only what the comparison reads, as a browser keeps a run."""
    d = r.to_dict()
    keep = ("top_k", "questions_fingerprint", "document_shas", "nondeterministic", "scored", "found", "hit_rate", "mrr")
    return {
        **{k: d[k] for k in keep},
        "questions": [{k: x[k] for k in ("id", "question", "found", "error")} for x in d["questions"]],
    }


def test_regression_on_dicts_agrees_with_against():
    from pandion.evaluation import regression

    now = report(q("q1", True), q("q2", False), q("q3", True), q("q4", False), nondeterministic=["llm_rerank"])
    assert regression(_slim(now), _slim(BEFORE)) == now.against(BEFORE)
    assert regression(now, BEFORE) == now.against(BEFORE)


def test_regression_reads_the_golds_when_a_dict_has_no_fingerprint():
    from pandion.evaluation import regression

    now = {**now_dict(), "questions_fingerprint": None}
    assert regression(now, BEFORE.to_dict()).partial is False


def now_dict() -> dict:
    return report(q("q1", True), q("q2", True), q("q3", False), q("q4", True)).to_dict()


def test_regression_refuses_what_is_not_a_report_in_a_plain_sentence():
    from pandion.evaluation import regression

    with pytest.raises(ValueError, match="The run to compare is not an evaluation report"):
        regression({"top_k": 5}, BEFORE)


def test_best_reads_dicts_as_it_reads_reports():
    from pandion.evaluation import best

    worse = report(q("q1", True), q("q2", False))
    better = report(q("q1", True), q("q2", True))
    assert best([worse, better]) == best([worse.to_dict(), better.to_dict()]) == [1]
    assert best([_slim(better), _slim(better)]) == [0, 1]
    assert best([report(q("q1", False)).to_dict()]) == []


def test_a_set_that_gains_ids_pairs_by_text_with_no_false_changes():
    before = report(q("question 1", True, "One?"), q("question 2", False, "Two?"))
    now = report(q("one", True, "One?"), q("two", True, "Two?"))
    r = now.against(before)
    assert (r.newly_missed, r.newly_found, r.unmatched) == ([], ["two"], [])


def test_real_ids_pair_first_then_the_rest_by_text():
    before = report(q("x", True, "Same?"), q("y", True, "Why?"), q("z", False, "Gone?"))
    now = report(q("x", False, "Changed?"), q("question 2", False, "Why?"), q("question 3", True, "New?"))
    r = now.against(before)
    assert r.newly_missed == ["x", "question 2"]
    assert r.newly_found == []
    assert r.unmatched == ["question 3", "z"]


def test_counts_are_over_the_questions_both_runs_scored():
    ids = "abcdefghijkl"
    broken = []
    for n, i in enumerate(ids):
        x = q(i, n < 9)
        if n >= 9:
            x.error = "boom"
        broken.append(x)
    r = report(*[q(i, i != "a") for i in ids]).against(report(*broken))
    assert (r.compared, r.found_before, r.found_now, r.newly_missed) == (9, 9, 8, ["a"])
