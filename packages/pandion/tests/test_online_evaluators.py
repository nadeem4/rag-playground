"""@online_evaluator: registration, the runner, and what it saves on a trace."""

import pytest

from pandion import online
from pandion.conversation_sql import SqlSettings, SqlStore
from pandion.extend import OnlineEvaluator, online_evaluator, plugin_listing, run_evaluators, summarise_traces
from pandion.trace_record import TraceRecord


@pytest.fixture(autouse=True)
def clean_registry():
    before = dict(online.EVALUATORS)
    online.EVALUATORS.clear()
    yield
    online.EVALUATORS.clear()
    online.EVALUATORS.update(before)


@pytest.fixture
def store(tmp_path):
    return SqlStore(SqlSettings(url=f"sqlite:///{(tmp_path / 'o.db').as_posix()}"))


def put(store, n=3, **kw):
    for i in range(n):
        store.save_trace(TraceRecord(trace_id=f"t{i}", user_id="u", conversation_id="c", question="q", answer="a" * (i + 1), **kw))


def length():
    @online_evaluator("length", version="1", outputs={"chars": "float", "long": "bool"})
    def length(trace):
        return {"chars": float(len(trace.answer)), "long": len(trace.answer) > 1}
    return length


def run(store, **kw):
    return run_evaluators(store, **{"since": None, "names": None, "sample": 1.0, "limit": 100, **kw})


def test_an_evaluator_is_registered_and_listed_by_pandion_plugins():
    length()
    row = next(r for r in plugin_listing() if r["kind"] == "online evaluator")
    assert row["name"] == "length" and row["level"] == "provisional"
    assert isinstance(online.EVALUATORS["length"], OnlineEvaluator)


def test_a_duplicate_name_is_refused():
    length()
    with pytest.raises(ValueError, match="'length' is already an online evaluator"):
        length()


def test_an_unknown_output_type_is_refused():
    with pytest.raises(ValueError, match="float, str or bool"):
        online_evaluator("bad", version="1", outputs={"x": "number"})


def test_scores_are_saved_on_the_trace(store):
    length(); put(store)
    result = run(store)
    assert result.scored == 3 and result.failures == {}
    assert store.trace("t1").scores == {"length@1.chars": 2.0, "length@1.long": True}


def test_outputs_must_match_the_declared_keys(store):
    @online_evaluator("wrong", version="1", outputs={"a": "float"})
    def wrong(trace):
        return {"b": 1.0}

    @online_evaluator("badtype", version="1", outputs={"a": "float"})
    def badtype(trace):
        return {"a": True}

    put(store, 1)
    result = run(store)
    assert result.failures == {"wrong@1": {"ValueError": 1}, "badtype@1": {"ValueError": 1}}
    assert store.trace("t0").scores == {}


def test_a_failing_evaluator_is_reported_and_others_still_run(store):
    @online_evaluator("boom", version="1", outputs={"a": "float"})
    def boom(trace):
        raise RuntimeError("secret user text: " + trace.question)

    length(); put(store)
    result = run(store)
    assert result.failures == {"boom@1": {"RuntimeError": 3}}
    assert "secret" not in result.model_dump_json()
    assert store.trace("t0").scores["length@1.chars"] == 1.0


def test_review_skips_traces_already_scored_by_the_same_version(store):
    length(); put(store)
    run(store)
    again = run(store)
    assert again.scored == 0 and again.skipped == 3
    assert run(store, rerun=True).scored == 3


def test_a_new_version_scores_again_beside_the_old(store):
    length(); put(store, 1)
    run(store)
    online.EVALUATORS.pop("length")
    online_evaluator("length", version="2", outputs={"chars": "float"})(lambda t: {"chars": 9.0})
    run(store)
    assert set(store.trace("t0").scores) == {"length@1.chars", "length@1.long", "length@2.chars"}


def test_scores_show_in_pandion_report_means(store):
    length(); put(store)
    run(store)
    report = summarise_traces(store.traces())
    assert report.score_means == {"length@1.chars": 2.0}
    assert report.score_counts == {"length@1.long: True": 2, "length@1.long: False": 1}


def test_sample_zero_scores_nothing(store):
    length(); put(store)
    assert run(store, sample=0.0).scored == 0
    assert store.trace("t0").scores == {}


def test_sampling_is_deterministic_and_partial(store):
    length(); put(store, 40)
    first = run(store, sample=0.5)
    chosen = {t.trace_id for t in store.traces() if t.scores}
    assert 0 < len(chosen) < 40 and first.scored == len(chosen)
    for t in store.traces():
        store.save_trace(t.model_copy(update={"scores": {}}))
    run(store, sample=0.5)
    assert {t.trace_id for t in store.traces() if t.scores} == chosen


def test_only_names_choose_the_evaluators_and_an_unknown_name_is_refused(store):
    length()
    online_evaluator("other", version="1", outputs={"x": "float"})(lambda t: {"x": 1.0})
    put(store, 1)
    run(store, names=["other"])
    assert set(store.trace("t0").scores) == {"other@1.x"}
    with pytest.raises(ValueError, match="no online evaluator named 'nope'"):
        run(store, names=["nope"])


def test_the_evaluator_gets_a_copy_so_it_cannot_change_the_stored_trace(store):
    @online_evaluator("mutate", version="1", outputs={"x": "float"})
    def mutate(trace):
        trace.answer = "changed"
        return {"x": 1.0}

    put(store, 1)
    run(store)
    assert store.trace("t0").answer == "a"


def test_a_nan_or_infinite_float_is_a_failure_and_saves_nothing(store):
    online_evaluator("nan", version="1", outputs={"x": "float"})(lambda t: {"x": float("nan")})
    online_evaluator("inf", version="1", outputs={"x": "float"})(lambda t: {"x": float("inf")})
    put(store, 1)
    result = run(store)
    assert result.failures == {"nan@1": {"ValueError": 1}, "inf@1": {"ValueError": 1}}
    assert store.trace("t0").scores == {}
