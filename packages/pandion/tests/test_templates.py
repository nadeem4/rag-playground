"""Pipeline templates: `pandion.list_templates` and `pandion.compose_template`."""

from __future__ import annotations

import pytest

import pandion
from pandion.formats import declared_formats
from pandion.pipeline_templates import SHARED_INDEX


def _by_id(family: str) -> dict[str, dict]:
    return {t["id"]: t for t in pandion.list_templates()[family]}


def test_both_families_have_their_templates():
    assert set(pandion.list_templates()) == {"index", "query", "shared"}
    assert set(_by_id("index")) == {"text", "tables", "scanned", "manuals", "web"}
    assert set(_by_id("query")) == {"balanced", "exact", "precision", "vague", "chat"}


@pytest.mark.parametrize("family", ["index", "query"])
def test_every_template_names_itself_and_says_what_it_is_good_for(family):
    for t in pandion.list_templates()[family]:
        assert t["name"] and t["summary"] and t["good_for"], t["id"]
        assert "\N{EM DASH}" not in t["summary"] + t["good_for"], f"{t['id']} has an em-dash"


#: The embed and store every index template had on main, before they were shared.
OLD_EMBED_AND_STORE = {
    "embed": {"use": "qwen3-embedding-0.6b"},
    "store": {"use": "lancedb", "metric": "cosine", "build_fts": True},
}


def test_shared_index_matches_the_old_templates():
    assert SHARED_INDEX == OLD_EMBED_AND_STORE
    assert pandion.list_templates()["shared"] == {"index": OLD_EMBED_AND_STORE}


def test_index_templates_have_no_embed_or_store():
    for t in _by_id("index").values():
        assert set(t["pipeline"]["category"]) <= {"parse", "clean", "chunk"}, t["id"]


def test_index_template_entry_shape():
    for t in _by_id("index").values():
        assert set(t["pipeline"]) == {"category"}, t["id"]
        assert {"parse", "chunk"} <= set(t["pipeline"]["category"]), t["id"]
        assert bool(t.get("sample")) == (t["id"] != "web"), t["id"]


def test_compose_makes_one_category_pipeline(tmp_path):
    config = pandion.compose_template("tables", "balanced", path=str(tmp_path))
    pandion.Pipeline.from_dict(config)
    tables = _by_id("index")["tables"]

    assert config["categories"] == {
        "tables": {"name": tables["name"], "template": "tables", **tables["pipeline"]["category"]}
    }
    assert config["route"] == [{"category": "tables"}]
    assert config["index"] == SHARED_INDEX
    out = pandion.Pipeline.from_dict(config).to_dict()
    assert out["categories"]["tables"]["template"] == "tables"
    assert out["route"] == [{"category": "tables"}]
    assert out["index"]["embed"] == OLD_EMBED_AND_STORE["embed"]
    assert out["index"]["store"] == OLD_EMBED_AND_STORE["store"]


def test_web_template_validates_and_loads_for_html(tmp_path):
    web = _by_id("index")["web"]
    assert web["name"] == "Web pages"
    category = web["pipeline"]["category"]
    assert category["parse"]["use"] == "docling"
    assert "html" in (declared_formats("docling") or [])
    p = pandion.Pipeline.from_dict(pandion.compose_template("web", "balanced", path=str(tmp_path)))
    assert p.config.index.categories["web"].chunk[0] == "markdown_header"


def test_a_query_template_sets_retrieval_and_the_answer_and_says_if_it_needs_a_key():
    queries = _by_id("query")
    for t in queries.values():
        assert set(t["pipeline"]) == {"retrieve", "answer"}, t["id"]
    assert sorted(q for q, t in queries.items() if t["needs_key"]) == ["chat", "vague"]


def test_compose_joins_an_index_and_a_query_template():
    config = pandion.compose_template("text", "balanced")
    text = _by_id("index")["text"]

    assert config == {
        "path": "./pandion-index",
        "categories": {"text": {"name": text["name"], "template": "text", **text["pipeline"]["category"]}},
        "route": [{"category": "text"}],
        "index": SHARED_INDEX,
        **_by_id("query")["balanced"]["pipeline"],
    }


def test_compose_takes_the_folder_and_hands_back_a_copy():
    config = pandion.compose_template("tables", "precision", path="my-index")
    config["categories"]["tables"]["parse"]["use"] = "changed"
    config["index"]["store"]["use"] = "changed"

    assert config["path"] == "my-index"
    again = pandion.compose_template("tables", "precision")
    assert again["categories"]["tables"]["parse"]["use"] == "docling"
    assert again["index"]["store"]["use"] == "lancedb"


def test_an_unknown_template_names_the_ones_there_are():
    with pytest.raises(ValueError, match="no index template named 'nope'.*manuals, scanned, tables, text, web"):
        pandion.compose_template("nope", "balanced")
    with pytest.raises(ValueError, match="no query template named 'nope'.*balanced, chat"):
        pandion.compose_template("text", "nope")


@pytest.mark.parametrize("index", ["text", "tables", "scanned", "manuals", "web"])
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
    chunk = _by_id("index")["manuals"]["pipeline"]["category"]["chunk"]
    assert chunk["use"] == "layout_blocks" and chunk["section_level"] == 4


def test_web_menu_pattern_drops_menu_lines_but_keeps_a_lone_heading_word():
    import re

    clean = _by_id("index")["web"]["pipeline"]["category"]["clean"]
    menu = re.compile(clean[1]["pattern"], re.I)
    assert menu.match("Home | About | Contact") and menu.match("About Contact")
    assert not menu.match("About") and not menu.match("Contact")


PAGE = """<html><body>
<p>We use cookies to improve your experience.</p>
<p>Home | About | Contact</p>
<h1>Ferns</h1>
<p>Ferns like deep shade.</p>
<h2>Water</h2>
<p>Water ferns weekly.</p>
<p>© 2024 Acme. All rights reserved.</p>
</body></html>"""


@pytest.mark.models
def test_web_template_drops_banner_menu_and_footer_and_cuts_at_headings(tmp_path):
    pytest.importorskip("docling")
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "ferns.html").write_text(PAGE, encoding="utf-8")
    config = pandion.compose_template("web", "balanced", path=str(tmp_path / "index"))
    config["index"] = {"embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}}
    p = pandion.Pipeline.from_dict(config)

    report = p.index.run(docs, through="chunk")

    assert report.ok, report
    chunks = report.documents["ferns.html"].stages["chunk"].output.chunks
    text = " ".join(c.text for c in chunks).lower()
    for gone in ("cookies", "contact", "rights reserved"):
        assert gone not in text, text
    assert len(chunks) == 2, [c.text for c in chunks]
