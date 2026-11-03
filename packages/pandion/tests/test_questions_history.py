"""A question can carry the earlier turns it follows; the key exists only when it has some."""

import json

import pytest

from pandion.evaluation import QuestionResult, _fingerprint
from pandion.questions import QuestionSetError, load_questions

BASE = {"id": "q1", "question": "And the notice?", "gold_answer": "Notice is 30 days."}
HISTORY = [{"question": "Tell me about the lease.", "answer": "It runs for two years."}]


def _result(**extra):
    return QuestionResult(
        id="q1", question="And the notice?", golds=["x"], tags=[], found=True, rank=1,
        lost_at=None, trace=None, score={}, **extra,
    )


def test_history_is_read_and_written_only_when_non_empty():
    assert load_questions([{**BASE, "history": HISTORY}])["questions"][0]["history"] == HISTORY
    assert "history" not in load_questions([BASE])["questions"][0]
    assert "history" not in load_questions([{**BASE, "history": []}])["questions"][0]
    assert _result(history=HISTORY).to_dict()["history"] == HISTORY
    assert "history" not in _result().to_dict()


def test_a_file_without_history_hashes_as_before():
    # A value computed before history existed: no stored baseline may go stale.
    assert _fingerprint([{"question": "q", "golds": ["g"]}]) == (
        "f3894a05e41d8c4768d838200e331f1f2367d2c2f3bca5cc542c49956c0ba2eb"
    )
    assert _fingerprint([{"question": "q", "golds": ["g"], "history": HISTORY}]) != _fingerprint(
        [{"question": "q", "golds": ["g"]}]
    )


@pytest.mark.parametrize(
    "bad",
    [
        [{"question": "only a question"}],
        [{"question": "q", "answer": 3}],
        ["not a pair"],
        "free text",
    ],
)
def test_history_with_a_bad_pair_names_the_line(bad):
    with pytest.raises(QuestionSetError, match=r"question 2: .*history"):
        load_questions([BASE, {**BASE, "history": bad}])


def test_a_json_file_keeps_history(tmp_path):
    path = tmp_path / "q.json"
    path.write_text(json.dumps({"questions": [{**BASE, "history": HISTORY}]}))
    assert load_questions(path)["questions"][0]["history"] == HISTORY
