"""`pandion.evaluation.find_gold`: where a gold passage sits in a list of pieces,
by the eval step's own rule, so Ask and Evaluate never disagree."""

from __future__ import annotations

import pytest

from pandion.evaluation import GoldFound, find_gold
from pandion.payloads import Chunk, Hit, Output, Query, RetrievalResult
from pandion.plugins.answer.eval import EvalConfig, EvalUseCase


def test_none_when_no_piece_holds_a_passage():
    assert find_gold(["the answer"], ["one piece", "another"]) is None
    assert find_gold(["the answer"], []) is None


@pytest.mark.parametrize(
    ("gold", "piece", "kind"),
    [
        ("Small chunks match closely.", "Small chunks match closely.", "exact"),
        # Curly quotes, a ligature and capitals: the case the old browser copy missed.
        ('It said "enough" twice.', "IT SAID “enough” twice.", "normalized"),
        ("The first figure", "See the ﬁrst figure.", "normalized"),
        ("benefit: 1. $2,000; or 2. the limit", "benefit:\n- $2,000; or\n- the limit", "reworded"),
    ],
)
def test_each_tier(gold, piece, kind):
    assert find_gold([gold], ["nothing here", piece]) == GoldFound(index=1, gold=gold, match=kind)


def test_the_first_piece_wins_and_names_the_first_gold_it_holds():
    golds = ["alpha beta", "gamma delta"]
    pieces = ["zzz", "gamma delta and alpha beta", "alpha beta"]
    assert find_gold(golds, pieces) == GoldFound(index=1, gold="alpha beta", match="exact")


def test_a_reworded_match_needs_every_other_word():
    assert find_gold(["pay $2,000 within 60 days"], ["pay $3,000 within 60 days"]) is None


def _eval(golds, texts, top_k):
    hits = [Hit(chunk=Chunk(id=f"c{i}", text=t, doc_id="d"), score=1.0, rank=i + 1) for i, t in enumerate(texts)]
    result = RetrievalResult(hits=hits, query_id="q" * 16, fetch_k=len(hits), total_candidates=len(hits))
    query = Query(text="q", gold_answers=golds)
    out = EvalUseCase().apply(
        {"result": result.model_dump(mode="json"), "query": query.model_dump(mode="json")},
        EvalConfig(top_k=top_k),
        None,
    )
    return Output.model_validate(out).payload


@pytest.mark.parametrize(
    ("golds", "texts"),
    [
        (["a b c"], ["x", "A  B\nc", "a b c"]),
        (["one two", "three four"], ["three four", "one two"]),
        (["“quoted” words"], ["no", "no", '"quoted" WORDS']),
        (["missing"], ["x", "y"]),
    ],
)
def test_the_eval_step_agrees(golds, texts):
    found = find_gold(golds, texts)
    score = _eval(golds, texts, top_k=len(texts))
    assert score["hit"] is (found is not None)
    if found is not None:
        assert score["rank"] == found.index + 1
        assert score["match"] == found.match


def test_the_eval_step_still_reports_found_at_below_top_k():
    score = _eval(["the answer"], ["x", "y", "has the answer"], top_k=2)
    assert score["hit"] is False
    assert score["found_at"] == 3
    assert score["golds_found"] == 0


def test_the_eval_step_counts_every_gold_found_in_top_k():
    score = _eval(["one", "two", "three"], ["has two", "has one", "has three"], top_k=2)
    assert (score["rank"], score["golds_found"], score["golds_total"]) == (1, 2, 3)


def test_each_passage_and_piece_is_normalised_once(monkeypatch):
    """The looser forms of a gold passage are made once, not once per piece:
    20 passages and 100 long pieces made them 4,000 times and took over a minute."""
    from pandion import textmatch

    calls: list[str] = []
    real = textmatch.normalise
    monkeypatch.setattr(textmatch, "normalise", lambda text: calls.append(text) or real(text))
    golds = ["first passage", "second passage", "third passage"]
    pieces = [f"piece number {n}" for n in range(5)]
    assert textmatch.first_matches(golds, pieces) == [None, None, None]
    assert sorted(calls) == sorted(golds + pieces)
