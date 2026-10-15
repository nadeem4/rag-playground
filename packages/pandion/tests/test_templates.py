"""Pipeline templates: `pandion.list_templates` and `pandion.compose_template`."""

from __future__ import annotations

import pytest

import pandion


def _by_id(family: str) -> dict[str, dict]:
    return {t["id"]: t for t in pandion.list_templates()[family]}


def test_both_families_have_their_templates():
    assert set(pandion.list_templates()) == {"index", "query"}
    assert set(_by_id("index")) == {"text", "tables", "scanned", "manuals"}
    assert set(_by_id("query")) == {"balanced", "exact", "precision", "vague", "chat"}


@pytest.mark.parametrize("family", ["index", "query"])
def test_every_template_names_itself_and_says_what_it_is_good_for(family):
    for t in pandion.list_templates()[family]:
        assert t["name"] and t["summary"] and t["good_for"], t["id"]
        assert "\N{EM DASH}" not in t["summary"] + t["good_for"], f"{t['id']} has an em-dash"


def test_an_index_template_sets_the_index_and_names_a_sample():
    for t in _by_id("index").values():
        assert set(t["pipeline"]) == {"index"}, t["id"]
        assert t["sample"], t["id"]


def test_a_query_template_sets_retrieval_and_the_answer_and_says_if_it_needs_a_key():
    queries = _by_id("query")
    for t in queries.values():
        assert set(t["pipeline"]) == {"retrieve", "answer"}, t["id"]
    assert sorted(q for q, t in queries.items() if t["needs_key"]) == ["chat", "vague"]


def test_compose_joins_an_index_and_a_query_template():
    config = pandion.compose_template("text", "balanced")

    assert config == {
        "path": "./pandion-index",
        **_by_id("index")["text"]["pipeline"],
        **_by_id("query")["balanced"]["pipeline"],
    }


def test_compose_takes_the_folder_and_hands_back_a_copy():
    config = pandion.compose_template("tables", "precision", path="my-index")
    config["index"]["parse"]["use"] = "changed"

    assert config["path"] == "my-index"
    assert pandion.compose_template("tables", "precision")["index"]["parse"]["use"] == "docling"


def test_an_unknown_template_names_the_ones_there_are():
    with pytest.raises(ValueError, match="no index template named 'nope'.*manuals, scanned, tables, text"):
        pandion.compose_template("nope", "balanced")
    with pytest.raises(ValueError, match="no query template named 'nope'.*balanced, chat"):
        pandion.compose_template("text", "nope")


@pytest.mark.parametrize("index", ["text", "tables", "scanned", "manuals"])
def test_every_composed_pair_is_a_valid_pipeline(index, tmp_path):
    for query in _by_id("query"):
        pandion.Pipeline.from_dict(pandion.compose_template(index, query, path=str(tmp_path)))


def _rerankers(query: str) -> list[dict]:
    return _by_id("query")[query]["pipeline"]["retrieve"].get("rerank") or []


def test_exact_terms_counts_the_keyword_search_more_than_the_meaning_search():
    search = _by_id("query")["exact"]["pipeline"]["retrieve"]["search"]
    assert search["use"] == "hybrid_rrf"
    assert search["bm25_weight"] > search.get("dense_weight", 1.0)


def test_balanced_reranks_with_the_small_cross_encoder_and_no_template_uses_mmr():
    assert _rerankers("balanced") == [
        {"use": "cross_encoder", "model": "cross-encoder/ms-marco-MiniLM-L-6-v2", "top_k": 5}
    ]
    assert not [q for q in _by_id("query") if any(r["use"] == "mmr" for r in _rerankers(q))]


def test_exact_terms_reranks_with_the_small_fast_cross_encoder():
    assert _rerankers("exact") == [
        {"use": "cross_encoder", "model": "cross-encoder/ms-marco-MiniLM-L-6-v2", "top_k": 5}
    ]


@pytest.mark.parametrize("query", ["precision", "vague", "chat"])
def test_the_precise_templates_rerank_with_the_strongest_cross_encoder(query):
    [rerank] = _rerankers(query)
    assert rerank["model"] == "BAAI/bge-reranker-v2-m3"
    assert rerank["model"] in pandion.catalog()["rerank"]["cross_encoder"]["config_schema"]["properties"]["model"]["enum"]


def test_vague_questions_says_the_reranker_reads_the_question_as_typed():
    assert "as typed" in _by_id("query")["vague"]["summary"]


@pytest.mark.parametrize("family", ["index", "query"])
def test_good_for_is_a_full_sentence(family):
    for t in pandion.list_templates()[family]:
        assert t["good_for"].startswith("It suits ") and t["good_for"].endswith("."), t["id"]


def test_manuals_starts_a_piece_at_headings_numbered_like_1_2_3():
    """Docling puts the title and "1" headings at level 2, so 1.2.3 is level 4."""
    chunk = _by_id("index")["manuals"]["pipeline"]["index"]["chunk"]
    assert chunk["use"] == "layout_blocks" and chunk["section_level"] == 4
