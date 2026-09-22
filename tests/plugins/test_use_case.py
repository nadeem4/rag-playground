"""Contract tests for the search use case.

The load-bearing assertion in this file is `test_cites_the_original_text_not_the
_embedded_text`: everything else is formatting, but citing the augmented text
would be a wrong answer wearing the costume of a right one.
"""

from __future__ import annotations

import json

from core.artifacts import ArtifactType
from core.payloads import Chunk, Hit, Output, RetrievalResult
from core.ports import Stage
from core.registry import registry
from plugins.use_case.search import SearchUseCase, SearchUseCaseConfig


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def hit(text: str, rank: int = 1, **kwargs) -> Hit:
    chunk_fields = {
        "id": kwargs.pop("chunk_id", f"chunk-{rank}"),
        "text": text,
        "embed_text": kwargs.pop("embed_text", None),
        "doc_id": kwargs.pop("doc_id", "doc-1"),
        "source_element_ids": kwargs.pop("source_element_ids", [f"el-{rank}"]),
        "page_span": kwargs.pop("page_span", (2, 3)),
    }
    return Hit(
        chunk=Chunk(**chunk_fields),
        score=kwargs.pop("score", 0.9),
        rank=rank,
        **kwargs,
    )


def run(*hits: Hit, **config) -> Output:
    payload = RetrievalResult(
        hits=list(hits),
        query_id="q" * 16,
        fetch_k=len(hits),
        total_candidates=len(hits),
    ).model_dump(mode="json")
    out = SearchUseCase().apply(
        {"result": payload}, SearchUseCaseConfig(**config), None
    )
    return Output.model_validate(out)


def results(output: Output) -> list[dict]:
    return output.payload["results"]


# --------------------------------------------------------------------------
# registration
# --------------------------------------------------------------------------


def test_registered_under_the_use_case_stage():
    assert registry.get(Stage.USE_CASE, "search") is SearchUseCase


def test_declares_one_result_port_and_outputs_an_output():
    assert SearchUseCase.output is ArtifactType.OUTPUT
    assert list(SearchUseCase.inputs) == ["result"]
    assert SearchUseCase.inputs["result"].type is ArtifactType.RETRIEVAL_RESULT


def test_is_cacheable_and_deterministic():
    """Unlike the future `chat`, a formatter has nothing to re-roll."""
    assert SearchUseCase.cacheable is True
    assert SearchUseCase.deterministic is True


def test_config_default():
    assert SearchUseCaseConfig().max_snippet_chars == 400
    assert SearchUseCaseConfig().top_k == 5


def test_shows_only_the_top_k_of_the_pool_and_counts_the_candidates():
    pool = [hit(f"passage {rank}", rank=rank) for rank in range(1, 21)]

    output = run(*pool, top_k=3)

    assert [row["rank"] for row in results(output)] == [1, 2, 3]
    assert output.payload["total_candidates"] == 20


def test_explain_names_top_k():
    exp = SearchUseCase().explain(SearchUseCaseConfig(top_k=7))
    assert "7" in exp.settings


# --------------------------------------------------------------------------
# formatting
# --------------------------------------------------------------------------


def test_kind_is_search():
    assert run(hit("Paris is the capital of France.")).kind == "search"


def test_formats_a_hit_into_one_result_row():
    out = run(hit("Paris is the capital of France.", rank=1, score=0.75))
    (row,) = results(out)
    assert row["rank"] == 1
    assert row["score"] == 0.75
    assert row["snippet"] == "Paris is the capital of France."
    assert row["chunk_id"] == "chunk-1"
    assert row["doc_id"] == "doc-1"
    assert row["page_span"] == [2, 3]
    assert row["source_element_ids"] == ["el-1"]


def test_keeps_hits_in_rank_order():
    out = run(hit("first", rank=1), hit("second", rank=2), hit("third", rank=3))
    assert [row["rank"] for row in results(out)] == [1, 2, 3]
    assert [row["snippet"] for row in results(out)] == ["first", "second", "third"]


def test_component_scores_survive_into_the_output():
    scores = {"dense": 0.8, "bm25": 0.2}
    out = run(hit("hybrid", component_scores=scores))
    assert results(out)[0]["component_scores"] == scores


def test_prior_rank_and_prior_score_survive_into_the_output():
    out = run(hit("moved", rank=1, prior_rank=7, prior_score=0.31))
    row = results(out)[0]
    assert row["prior_rank"] == 7
    assert row["prior_score"] == 0.31


def test_absent_rank_movement_is_null_not_missing():
    row = results(run(hit("unreranked")))[0]
    assert row["prior_rank"] is None
    assert row["prior_score"] is None


def test_a_chunk_without_pages_reports_a_null_span():
    row = results(run(hit("no pages", page_span=None)))[0]
    assert row["page_span"] is None


# --------------------------------------------------------------------------
# the citation seam
# --------------------------------------------------------------------------


def test_cites_the_original_text_not_the_embedded_text():
    """Contextual retrieval retrieves on augmented text and cites the original."""
    out = run(
        hit(
            "Revenue grew 12%.",
            embed_text="From the 2024 annual report, Acme Corp: Revenue grew 12%.",
        )
    )
    assert results(out)[0]["snippet"] == "Revenue grew 12%."


# --------------------------------------------------------------------------
# truncation
# --------------------------------------------------------------------------


def test_snippet_is_truncated_to_max_snippet_chars():
    out = run(hit("x" * 1000), max_snippet_chars=400)
    assert len(results(out)[0]["snippet"]) == 400


def test_a_short_snippet_is_left_alone():
    out = run(hit("short"), max_snippet_chars=400)
    assert results(out)[0]["snippet"] == "short"


def test_truncation_does_not_split_a_character():
    """Multi-byte text truncates on code points, never inside one."""
    text = "café ☕ naïve 🇫🇷 " * 50
    out = run(hit(text), max_snippet_chars=17)
    snippet = results(out)[0]["snippet"]
    assert len(snippet) == 17
    assert text.startswith(snippet)
    assert "�" not in snippet
    assert json.loads(json.dumps(snippet)) == snippet
    assert snippet.encode("utf-8").decode("utf-8") == snippet


def test_truncation_counts_characters_not_bytes():
    text = "🇫🇷" * 100
    out = run(hit(text), max_snippet_chars=10)
    assert len(results(out)[0]["snippet"]) == 10


# --------------------------------------------------------------------------
# edges
# --------------------------------------------------------------------------


def test_an_empty_result_produces_a_valid_empty_output():
    out = run()
    assert out.kind == "search"
    assert results(out) == []


def test_the_output_payload_is_json_serializable():
    out = run(hit("a", rank=1), hit("b", rank=2))
    assert json.loads(json.dumps(out.payload)) == out.payload


def test_the_query_id_is_carried_for_provenance():
    assert run(hit("a")).payload["query_id"] == "q" * 16
