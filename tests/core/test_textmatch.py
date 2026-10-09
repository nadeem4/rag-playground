"""One matching rule for the question check, the eval step and the miss trace.

Before this module the upload check folded curly quotes and the eval step did
not, so a question the check called "in the document" could miss on every run
with the retriever blamed. These tests pin the shared rule and pin the check
and the score to each other.
"""

from __future__ import annotations

import pytest

from api.questions import check_questions
from core.payloads import Chunk, Hit, Output, Query, RetrievalResult
from core.textmatch import normalise, normalise_with_offsets
from plugins.use_case.eval import EvalConfig, EvalUseCase, _normalise


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("A  retriever\n scores\teach chunk.", "a retriever scores each chunk."),
        ("over-\nlap and over- \n  lap", "overlap and overlap"),
        ("“quoted” and ‘single’", "\"quoted\" and 'single'"),
        ("ﬁne ﬂat ﬀect ﬃce ﬄe", "fine flat ffect ffice ffle"),
        ("STRASSE Straße", "strasse strasse"),
        ("  trailing  ", "trailing"),
    ],
)
def test_the_shared_rule(raw: str, expected: str) -> None:
    assert normalise(raw) == expected


def test_offsets_point_back_into_the_original_text() -> None:
    raw = "The ﬁrst  “line”"
    folded, index = normalise_with_offsets(raw)
    assert folded == normalise(raw)
    assert len(index) == len(folded)
    # Both letters of the expanded ligature point at the one source character.
    at = folded.index("fi")
    assert index[at] == index[at + 1] == raw.index("ﬁ")


def test_eval_keeps_its_old_name_for_the_shared_rule() -> None:
    # The miss trace imports `_normalise` from the eval step.
    assert _normalise("“A”") == normalise("“A”")


def _eval_hit(gold: str, chunk_text: str) -> Output:
    result = RetrievalResult(
        hits=[Hit(chunk=Chunk(id="c1", text=chunk_text, doc_id="d"), score=1.0, rank=1)],
        query_id="q" * 16,
        fetch_k=1,
        total_candidates=1,
    ).model_dump(mode="json")
    query = Query(text="q", gold_answer=gold)
    return Output.model_validate(
        EvalUseCase().apply(
            {"result": result, "query": query.model_dump(mode="json")}, EvalConfig(top_k=5), None
        )
    )


@pytest.mark.parametrize(
    ("gold", "document"),
    [
        ('It said "enough" twice.', "Before that, it said “enough” twice. After."),
        ("The first figure", "See the ﬁrst figure on page 2."),
        ("Readers lost their place less often.", "readers lost their\n place less of-\nten."),
        ("It's the reader's choice.", "It’s the reader’s choice."),
    ],
)
def test_what_the_check_finds_the_score_finds(gold: str, document: str) -> None:
    row = check_questions([{"question": "q", "gold_answers": [gold]}], document)[0]
    assert row["status"] in {"found", "found_normalized"}
    out = _eval_hit(gold, document)
    assert out.payload["hit"] is True
    assert out.payload["match"] == ("exact" if row["status"] == "found" else "normalized")
