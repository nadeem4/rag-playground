"""I-24: the `eval` use case, which says whether retrieval found the answer.

Gold is text, never a chunk id: a chunk id only exists for one chunking setting,
so a label tied to one would be worthless exactly when settings are compared.
The load-bearing assertions here are the ones about `match`: a near miss must
read as a miss, and a match that only survived whitespace normalisation must say
so rather than pass as an exact one.
"""

from __future__ import annotations

import json

import pytest

from core.artifacts import ArtifactType
from core.payloads import Chunk, Hit, Output, Query, RetrievalResult
from core.ports import Stage
from core.registry import registry
from plugins.use_case.eval import EvalConfig, EvalUseCase

GOLD = "A retriever scores each chunk as a whole."


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def hit(text: str, rank: int = 1, chunk_id: str | None = None) -> Hit:
    return Hit(
        chunk=Chunk(id=chunk_id or f"chunk-{rank}", text=text, doc_id="doc-1"),
        score=1.0 / rank,
        rank=rank,
    )


def run(
    *hits: Hit,
    question: str = "How does a retriever score a chunk?",
    gold: str = GOLD,
    golds: list[str] | None = None,
    total_candidates: int | None = None,
    **config,
) -> Output:
    result = RetrievalResult(
        hits=list(hits),
        query_id="q" * 16,
        fetch_k=len(hits),
        total_candidates=len(hits) if total_candidates is None else total_candidates,
    ).model_dump(mode="json")
    query = Query(text=question, gold_answer=gold, gold_answers=golds or [])
    out = EvalUseCase().apply(
        {"result": result, "query": query.model_dump(mode="json")},
        EvalConfig(**config),
        None,
    )
    return Output.model_validate(out)


# --------------------------------------------------------------------------
# registration and declarations
# --------------------------------------------------------------------------


def test_registered_under_the_use_case_stage():
    assert registry.get(Stage.USE_CASE, "eval") is EvalUseCase


def test_declares_an_explicit_result_port_and_an_ambient_query():
    assert EvalUseCase.output is ArtifactType.OUTPUT
    assert list(EvalUseCase.inputs) == ["result", "query"]
    assert EvalUseCase.inputs["result"].type is ArtifactType.RETRIEVAL_RESULT
    assert EvalUseCase.inputs["result"].ambient is False
    assert EvalUseCase.inputs["query"].type is ArtifactType.QUERY
    assert EvalUseCase.inputs["query"].ambient is True


def test_is_cacheable_and_deterministic():
    """Pure arithmetic over its inputs, so the cache key is sound."""
    assert EvalUseCase.cacheable is True
    assert EvalUseCase.deterministic is True


def test_config_default():
    assert EvalConfig().top_k == 5


def test_kind_is_eval():
    assert run(hit(GOLD)).kind == "eval"


def test_the_payload_has_the_i24_shape():
    payload = run(hit(GOLD)).payload
    assert set(payload) == {
        "question",
        "gold_answer",
        "hit",
        "rank",
        "matched_chunk_id",
        "match",
        "considered",
        "total_candidates",
        # I-32
        "golds_total",
        "golds_found",
    }
    assert json.loads(json.dumps(payload)) == payload


# --------------------------------------------------------------------------
# hits, deeper hits, and misses
# --------------------------------------------------------------------------


def test_a_hit_at_rank_one():
    payload = run(hit(f"Boundaries. {GOLD} And so on.", rank=1)).payload
    assert payload["hit"] is True
    assert payload["rank"] == 1
    assert payload["match"] == "exact"
    assert payload["matched_chunk_id"] == "chunk-1"


def test_a_hit_deeper_in_the_list_reports_its_rank():
    payload = run(
        hit("something else", rank=1),
        hit("another passage", rank=2),
        hit(GOLD, rank=3),
    ).payload
    assert payload["hit"] is True
    assert payload["rank"] == 3
    assert payload["matched_chunk_id"] == "chunk-3"


def test_the_first_containing_hit_wins_when_several_contain_it():
    payload = run(hit(GOLD, rank=1), hit(GOLD, rank=2)).payload
    assert payload["rank"] == 1
    assert payload["matched_chunk_id"] == "chunk-1"


def test_a_miss_reports_no_rank_and_no_match():
    payload = run(hit("nothing like it", rank=1)).payload
    assert payload["hit"] is False
    assert payload["rank"] is None
    assert payload["matched_chunk_id"] == ""
    assert payload["match"] == "none"


def test_a_gold_sentence_that_is_nowhere_is_a_miss():
    payload = run(
        hit("one", rank=1),
        hit("two", rank=2),
        gold="This sentence appears in no chunk at all.",
    ).payload
    assert payload["hit"] is False
    assert payload["rank"] is None
    assert payload["match"] == "none"


def test_a_near_miss_is_a_miss():
    """Never fuzzy: one word different is not a match."""
    payload = run(hit("A retriever scores every chunk as a whole.")).payload
    assert payload["hit"] is False
    assert payload["match"] == "none"


def test_an_empty_result_is_a_miss_with_nothing_considered():
    payload = run().payload
    assert payload["hit"] is False
    assert payload["considered"] == 0
    assert payload["total_candidates"] == 0


# --------------------------------------------------------------------------
# top_k and what was considered
# --------------------------------------------------------------------------


def test_top_k_cuts_off_a_hit_that_sits_below_it():
    hits = [hit(f"passage {r}", rank=r) for r in range(1, 6)] + [hit(GOLD, rank=6)]
    assert run(*hits, top_k=10).payload["rank"] == 6
    cut = run(*hits, top_k=5).payload
    assert cut["hit"] is False
    assert cut["rank"] is None
    assert cut["match"] == "none"
    assert cut["considered"] == 5


def test_considered_reports_what_was_checked():
    hits = [hit(f"passage {r}", rank=r) for r in range(1, 21)]
    assert run(*hits, top_k=5).payload["considered"] == 5
    assert run(*hits, top_k=50).payload["considered"] == 20
    assert run(hit("one"), top_k=5).payload["considered"] == 1


def test_total_candidates_is_the_whole_pool_not_what_was_considered():
    hits = [hit(f"passage {r}", rank=r) for r in range(1, 11)]
    payload = run(*hits, top_k=3, total_candidates=200).payload
    assert payload["considered"] == 3
    assert payload["total_candidates"] == 200


# --------------------------------------------------------------------------
# the normalised match
# --------------------------------------------------------------------------


def test_normalised_match_catches_different_spacing():
    chunk_text = "A  retriever scores\neach chunk\tas a whole."
    payload = run(hit(chunk_text)).payload
    assert payload["hit"] is True
    assert payload["rank"] == 1
    assert payload["match"] == "normalized"


def test_normalised_match_rejoins_a_word_hyphenated_at_a_line_end():
    payload = run(
        hit("A retrie-\nver scores each chunk as a whole."),
    ).payload
    assert payload["hit"] is True
    assert payload["match"] == "normalized"


def test_normalised_match_ignores_case():
    payload = run(hit("a retriever SCORES each chunk as a whole.")).payload
    assert payload["hit"] is True
    assert payload["match"] == "normalized"


def test_an_exact_match_is_not_reported_as_normalized():
    assert run(hit(GOLD)).payload["match"] == "exact"


def test_an_exact_hit_deeper_down_does_not_outrank_a_normalised_hit_above_it():
    """`rank` is the rank of the first containing hit, whichever kind it is."""
    payload = run(hit("A  retriever scores each chunk as a whole.", rank=1),
                  hit(GOLD, rank=2)).payload
    assert payload["rank"] == 1
    assert payload["match"] == "normalized"


# --------------------------------------------------------------------------
# what it reports back
# --------------------------------------------------------------------------


def test_the_question_and_gold_answer_are_carried_into_the_report():
    payload = run(hit(GOLD), question="How is a chunk scored?").payload
    assert payload["question"] == "How is a chunk scored?"
    assert payload["gold_answer"] == GOLD


def test_surrounding_whitespace_in_the_gold_answer_is_ignored():
    payload = run(hit(GOLD), gold=f"  {GOLD}\n").payload
    assert payload["hit"] is True
    assert payload["match"] == "exact"
    assert payload["gold_answer"] == GOLD


# --------------------------------------------------------------------------
# a missing gold answer
# --------------------------------------------------------------------------


def test_a_missing_gold_answer_fails_the_node_naming_the_query_node():
    with pytest.raises(ValueError) as excinfo:
        run(hit(GOLD), gold="")
    message = str(excinfo.value)
    assert "gold_answer" in message
    assert "query" in message.lower()


def test_a_blank_gold_answer_fails_too():
    with pytest.raises(ValueError):
        run(hit(GOLD), gold="   \n ")


# --------------------------------------------------------------------------
# I-32: several gold passages, any of which counts
# --------------------------------------------------------------------------

OTHER = "Scoring happens once per chunk."


def test_one_gold_answer_counts_one_gold():
    payload = run(hit(GOLD)).payload
    assert (payload["golds_total"], payload["golds_found"]) == (1, 1)
    assert run(hit("nothing like it")).payload["golds_found"] == 0


def test_several_golds_are_counted_and_any_of_them_is_a_hit():
    payload = run(hit(OTHER), gold="", golds=[GOLD, OTHER]).payload
    assert payload["golds_total"] == 2
    assert payload["golds_found"] == 1
    assert payload["hit"] is True
    assert payload["rank"] == 1


def test_golds_found_counts_every_gold_that_appeared():
    payload = run(
        hit(GOLD, rank=1), hit(OTHER, rank=2), gold="", golds=[GOLD, OTHER]
    ).payload
    assert (payload["golds_total"], payload["golds_found"]) == (2, 2)


def test_a_gold_below_top_k_does_not_count_as_found():
    hits = [hit(f"passage {r}", rank=r) for r in range(1, 5)] + [
        hit(GOLD, rank=5),
        hit(OTHER, rank=6),
    ]
    payload = run(*hits, gold="", golds=[GOLD, OTHER], top_k=5).payload
    assert (payload["golds_total"], payload["golds_found"]) == (2, 1)
    assert payload["rank"] == 5


def test_rank_is_the_earliest_hit_whichever_gold_it_holds():
    payload = run(
        hit(OTHER, rank=1), hit(GOLD, rank=2), gold="", golds=[GOLD, OTHER]
    ).payload
    assert payload["rank"] == 1
    assert payload["matched_chunk_id"] == "chunk-1"


def test_the_single_gold_answer_joins_the_list_and_is_reported_first():
    payload = run(hit(OTHER), gold=GOLD, golds=[OTHER]).payload
    assert payload["gold_answer"] == GOLD
    assert (payload["golds_total"], payload["golds_found"]) == (2, 1)


def test_a_repeated_gold_is_counted_once():
    payload = run(hit(GOLD), gold=GOLD, golds=[GOLD]).payload
    assert (payload["golds_total"], payload["golds_found"]) == (1, 1)


def test_golds_alone_with_no_single_gold_answer_is_enough():
    payload = run(hit(GOLD), gold="", golds=[GOLD]).payload
    assert payload["hit"] is True
    assert payload["gold_answer"] == GOLD


def test_an_empty_list_and_an_empty_gold_answer_still_fails_the_node():
    with pytest.raises(ValueError):
        run(hit(GOLD), gold="", golds=["  "])


def test_a_normalised_match_counts_as_found_for_its_own_gold():
    payload = run(
        hit("Scoring   happens once per chunk."), gold="", golds=[GOLD, OTHER]
    ).payload
    assert payload["golds_found"] == 1
    assert payload["match"] == "normalized"


# --------------------------------------------------------------------------
# determinism
# --------------------------------------------------------------------------


def test_the_same_inputs_give_the_same_report():
    hits = [hit(f"passage {r}", rank=r) for r in range(1, 5)] + [hit(GOLD, rank=5)]
    assert run(*hits).payload == run(*hits).payload


# --------------------------------------------------------------------------
# explanations
# --------------------------------------------------------------------------


def test_explain_names_top_k():
    assert "7" in EvalUseCase().explain(EvalConfig(top_k=7)).settings


def test_explain_warns_and_blocks_when_nothing_would_be_checked():
    exp = EvalUseCase().explain(EvalConfig(top_k=0))
    assert exp.warning and exp.blocking is True
