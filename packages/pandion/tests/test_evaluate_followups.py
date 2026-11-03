"""A follow-up case is searched with its standalone rewrite, as a chat turn would be.

The rewrite model is faked; nothing reaches the network and no model loads.
"""

import pytest

import pandion
from pandion import Pipeline
from pandion.chat_turn import ChatSettings
from pandion.llm import Completion
from pdfs import SAMPLE_PAGES, build_pdf

HISTORY = [{"question": "Tell me about France.", "answer": "It is a country in Europe."}]
FOLLOWUP = {
    "id": "followup",
    "question": "And its capital?",
    "gold_answer": "The capital of France is Paris.",
    "history": HISTORY,
}
PLAIN = {
    "id": "plain",
    "question": "What is the capital of France?",
    "gold_answer": "The capital of France is Paris.",
}


class Fake:
    def __init__(self, reply="What is the capital of France?", raises=None):
        self.reply, self.raises, self.calls = reply, raises, []

    def __call__(self, model, **kwargs):
        self.calls.append({"model": model, **kwargs})
        if self.raises:
            raise self.raises
        return Completion(text=self.reply, usage={}, stop_reason="end_turn")


@pytest.fixture
def p(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "sample.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    pipe = Pipeline(
        path=tmp_path / "index",
        parse="pdfium",
        chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        embed="fake-deterministic",
        store="lancedb",
        search={"use": "hybrid_rrf", "top_k": 5},
    )
    pipe.index.run(folder)
    return pipe


def searched(p, monkeypatch):
    """The query text each retrieval was given."""
    seen = []
    real = p.retrieval._retrieve

    def spy(text, *args, **kwargs):
        seen.append(text)
        return real(text, *args, **kwargs)

    monkeypatch.setattr(p.retrieval, "_retrieve", spy)
    return seen


def test_a_followup_is_searched_with_its_rewrite(p, monkeypatch):
    fake = Fake()
    monkeypatch.setattr("pandion.llm.complete", fake)
    seen = searched(p, monkeypatch)
    q = pandion.evaluate(p, [FOLLOWUP]).questions[0]
    assert seen == ["What is the capital of France?"]
    assert q.found
    assert "Tell me about France." in fake.calls[0]["user"] and "And its capital?" in fake.calls[0]["user"]


def test_the_rewrite_uses_the_chat_settings_model(p, monkeypatch):
    fake = Fake()
    monkeypatch.setattr("pandion.llm.complete", fake)
    pandion.evaluate(p, [FOLLOWUP], chat=ChatSettings(rewrite_model="claude-sonnet-5"))
    assert fake.calls[0]["model"].id == "claude-sonnet-5"


def test_a_case_without_history_makes_no_rewrite_call(p, monkeypatch):
    fake = Fake()
    monkeypatch.setattr("pandion.llm.complete", fake)
    seen = searched(p, monkeypatch)
    q = pandion.evaluate(p, [PLAIN]).questions[0]
    assert fake.calls == [] and seen == ["What is the capital of France?"]
    assert q.rewrite is None and "rewrite" not in q.to_dict()


def test_the_report_records_the_rewrite_used(p, monkeypatch):
    monkeypatch.setattr("pandion.llm.complete", Fake())
    report = pandion.evaluate(p, [FOLLOWUP, PLAIN])
    data = report.to_dict()["questions"]
    assert data[0]["rewrite"] == "What is the capital of France?"
    assert data[0]["rewrite_reason"] == "rewritten"
    assert data[0]["history"] == HISTORY
    assert report.rewrites_failed == 0


def test_a_failed_rewrite_falls_back_to_the_question_and_is_counted(p, monkeypatch):
    monkeypatch.setattr("pandion.llm.complete", Fake(raises=RuntimeError("down")))
    seen = searched(p, monkeypatch)
    report = pandion.evaluate(p, [FOLLOWUP])
    assert seen == ["And its capital?"]
    q = report.questions[0]
    assert (q.rewrite, q.rewrite_reason) == ("And its capital?", "failed")
    assert report.rewrites_failed == 1
    assert report.to_dict()["rewrites_failed"] == 1
    assert "rewrites_failed" not in pandion.evaluate(p, [PLAIN]).to_dict()


def test_followup_cases_are_their_own_category_in_by_category(p, monkeypatch):
    monkeypatch.setattr("pandion.llm.complete", Fake())
    cases = [FOLLOWUP, PLAIN, {**PLAIN, "id": "tagged", "tags": ["category:facts"]}]
    now = pandion.evaluate(p, cases)
    regression = now.against(now)
    assert sorted(regression.by_category) == ["facts", "follow-up", "uncategorized"]


def test_a_followup_run_lists_the_rewrite_as_nondeterministic(p, monkeypatch):
    monkeypatch.setattr("pandion.llm.complete", Fake())
    assert "chat rewrite" in pandion.evaluate(p, [FOLLOWUP]).nondeterministic
    assert "chat rewrite" not in pandion.evaluate(p, [PLAIN]).nondeterministic


def test_a_newly_missed_followup_is_asked_again_with_the_same_chat_settings(p, monkeypatch):
    fake = Fake()
    monkeypatch.setattr("pandion.llm.complete", fake)
    baseline = pandion.evaluate(p, [FOLLOWUP]).to_dict()
    missed = {**FOLLOWUP, "gold_answer": "Madrid is the capital of Spain."}
    chat = ChatSettings(rewrite_model="claude-sonnet-5")
    report = pandion.evaluate(p, [missed], chat=chat)
    fake.calls.clear()
    report, again = pandion.evaluation.reask_missed(p, report, baseline, [missed], chat=chat)
    assert again == ["followup"]
    assert [c["model"].id for c in fake.calls] == ["claude-sonnet-5"]


def test_the_baseline_records_the_rewrite_model_only_for_followups(p):
    with_followup = pandion.evaluation.environment(p, [FOLLOWUP])
    assert "claude-haiku-4-5" in with_followup["models"]
    assert "claude-haiku-4-5" not in pandion.evaluation.environment(p, [PLAIN])["models"]
    chosen = pandion.evaluation.environment(p, [FOLLOWUP], ChatSettings(rewrite_model="claude-sonnet-5"))
    assert "claude-sonnet-5" in chosen["models"]
