"""pandion review --promote turns a trace into a question-set case."""

import json
from types import SimpleNamespace

import pytest

from pandion import cli
from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.conversation_store import Turn
from pandion.questions import load_questions
from pandion.trace_record import TraceRecord, TraceSource

VAR = "PANDION_TEST_PROMOTE_URL"
GOLD = "The notice period is 30 days."


@pytest.fixture
def store(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'p.db').as_posix()}"
    monkeypatch.setenv(VAR, url)
    s = SqlStore(SqlSettings(url=url))
    s.append("conv", "u", Turn(question="What is the contract?", answer="A lease.", rewrite="What is the contract?", source_ids=["s0"], trace_id="first"))
    s.append("conv", "u", Turn(question="and the notice?", answer="30 days.", rewrite="What is the notice period?", source_ids=["s1"], trace_id="follow"))
    s.save_trace(TraceRecord(trace_id="first", user_id="u", conversation_id="conv", question="What is the contract?", standalone="What is the contract?",
                             answer="A lease.", source_ids=["s0"], sources=[TraceSource(id="s0", text="This is a lease.")]))
    s.save_trace(TraceRecord(trace_id="follow", user_id="u", conversation_id="conv", question="and the notice?", standalone="What is the notice period?",
                             answer="30 days.", source_ids=["s1"], sources=[TraceSource(id="s1", text=GOLD)]))
    s.save_trace(TraceRecord(trace_id="bare", user_id="u", conversation_id="other", question="old?", answer="a"))
    return s


def promote(path, trace_id, *extra):
    return cli.main(["review", "--promote", trace_id, "--questions", str(path), "--url-env", VAR, *extra])


def cases(path):
    body = json.loads(path.read_text(encoding="utf-8"))
    return body["questions"] if isinstance(body, dict) else body


def test_promote_appends_a_case_to_the_questions_file(store, tmp_path, capsys):
    path = tmp_path / "q.json"
    assert promote(path, "first") == 0
    (case,) = cases(path)
    assert case["id"] == "first" and case["question"] == "What is the contract?"
    assert case["gold_answers"] == ["This is a lease."]
    assert "history" not in case
    assert "first" in capsys.readouterr().out


def test_promote_a_followup_keeps_its_history(store, tmp_path):
    path = tmp_path / "q.json"
    assert promote(path, "follow") == 0
    (case,) = cases(path)
    assert case["question"] == "and the notice?"  # the original, so evaluate replays the rewrite
    assert case["history"] == [{"question": "What is the contract?", "answer": "A lease."}]


def test_promote_twice_does_not_duplicate(store, tmp_path, capsys):
    path = tmp_path / "q.json"
    promote(path, "first")
    capsys.readouterr()
    assert promote(path, "first") == 0
    assert len(cases(path)) == 1
    assert "already" in capsys.readouterr().out


def test_promote_keeps_the_cases_already_in_the_file(store, tmp_path):
    path = tmp_path / "q.json"
    path.write_text(json.dumps({"version": 1, "questions": [{"id": "mine", "question": "q", "gold_answers": ["g"]}]}), encoding="utf-8")
    promote(path, "first")
    assert [c["id"] for c in cases(path)] == ["mine", "first"]


def test_promote_missing_trace_exits_1_with_a_sentence(store, tmp_path, capsys):
    path = tmp_path / "q.json"
    assert promote(path, "nope") == 1
    assert "no trace" in capsys.readouterr().err.lower()
    assert not path.exists()


def test_promote_a_trace_without_stored_passages_exits_1(store, tmp_path, capsys):
    assert promote(tmp_path / "q.json", "bare") == 1
    assert "passages" in capsys.readouterr().err


def _fingerprint_of(path):
    from pandion.evaluation import _fingerprint

    return _fingerprint([{**q, "golds": q["gold_answers"]} for q in load_questions(path)["questions"]])


def test_promoted_file_still_loads_and_hashes(store, tmp_path):
    path = tmp_path / "q.json"
    promote(path, "first")
    before = _fingerprint_of(path)
    promote(path, "follow")
    loaded = load_questions(path)
    assert [q["id"] for q in loaded["questions"]] == ["first", "follow"]
    assert loaded["questions"][1]["history"]
    after = _fingerprint_of(path)
    assert after != before
    assert after == _fingerprint_of(path)  # a fresh load of the same file hashes the same


def test_promote_prints_the_trim_hint(store, tmp_path, capsys):
    promote(tmp_path / "q.json", "first")
    assert "sentence that answers" in capsys.readouterr().out


def test_promote_with_a_stale_passage_says_so(store, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_load", lambda args: object())
    monkeypatch.setattr("pandion.evaluation.stale_check", lambda p, q, *a, **k: SimpleNamespace(ok=False, warnings=[]))
    assert promote(tmp_path / "q.json", "first", "pipe.yaml") == 0
    assert "no longer in the document" in capsys.readouterr().out


def test_promote_with_a_pipeline_names_retrieval_or_answer(store, tmp_path, monkeypatch, capsys):

    found = {"v": True}
    monkeypatch.setattr(cli, "_load", lambda args: object())
    monkeypatch.setattr("pandion.evaluation.stale_check", lambda p, q, *a, **k: SimpleNamespace(ok=True, warnings=[]))
    monkeypatch.setattr("pandion.evaluation.evaluate", lambda p, q, *a, **k: SimpleNamespace(questions=[SimpleNamespace(found=found["v"], error=None)]))
    path = tmp_path / "q.json"
    assert promote(path, "first", "pipe.yaml") == 0
    assert "answer step" in capsys.readouterr().out
    found["v"] = False
    assert promote(path, "follow", "pipe.yaml") == 0
    assert "retrieval" in capsys.readouterr().out
