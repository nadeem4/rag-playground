"""catalog(), defaults() and explain(): what an app needs to draw settings forms."""

import json

import pytest

import pandion
from pandion import ConfigError, Pipeline


def test_they_are_public():
    for name in ("catalog", "defaults", "explain"):
        assert name in pandion.__all__


def test_catalog_lists_every_stage_with_each_strategys_settings():
    catalog = pandion.catalog()
    assert {"source", "parse", "clean", "chunk", "index", "query", "retrieve", "rerank", "use_case"} <= set(catalog)
    recursive = catalog["chunk"]["recursive_character"]
    assert recursive["config_schema"]["properties"]["chunk_size"]["default"] == 400
    assert recursive["summary"]
    assert json.loads(json.dumps(catalog)) == catalog


def test_changing_what_catalog_returns_does_not_change_the_next_call():
    first = pandion.catalog()
    before = json.dumps(first, sort_keys=True)

    def scribble(value):
        if isinstance(value, dict):
            for item in list(value.values()):
                scribble(item)
            value["scribbled"] = True
        elif isinstance(value, list):
            for item in value:
                scribble(item)
            value.append("scribbled")

    scribble(first)
    assert json.dumps(pandion.catalog(), sort_keys=True) == before


def test_defaults_name_a_strategy_for_every_required_part():
    assert pandion.defaults() == {
        "parse": "docling",
        "chunk": "recursive_character",
        "embed": "qwen3-embedding-0.6b",
        "store": "lancedb",
        "search": "hybrid_rrf",
        "answer": "search",
    }


def test_every_default_is_in_the_catalog():
    catalog, d = pandion.catalog(), pandion.defaults()
    assert d["parse"] in catalog["parse"] and d["chunk"] in catalog["chunk"]
    assert d["store"] in catalog["index"] and d["search"] in catalog["retrieve"]
    assert d["answer"] in catalog["use_case"]
    assert d["embed"] in catalog["index"]["lancedb"]["config_schema"]["properties"]["embedder"]["x-labels"]


def test_the_defaults_make_a_valid_pipeline(tmp_path):
    d = pandion.defaults()
    Pipeline.from_dict(
        {
            "path": str(tmp_path),
            "index": {k: {"use": d[k]} for k in ("parse", "chunk", "embed", "store")},
            "retrieve": {"search": {"use": d["search"]}},
            "answer": {"use": d["answer"]},
        }
    )


def test_explain_says_what_one_strategy_will_do():
    said = pandion.explain("chunk", "recursive_character", {"chunk_size": 100, "chunk_overlap": 200})
    assert said["blocking"] is True
    assert "smaller than the chunk size" in said["warning"]
    assert pandion.explain("chunk", "recursive_character")["blocking"] is False


def test_explain_refuses_what_does_not_exist():
    with pytest.raises(KeyError, match="'chunks' is not a stage"):
        pandion.explain("chunks", "recursive_character")
    with pytest.raises(KeyError, match="which is not a chunk strategy"):
        pandion.explain("chunk", "fixed")
    with pytest.raises(ConfigError, match="has no setting 'chunk_sise'"):
        pandion.explain("chunk", "recursive_character", {"chunk_sise": 100})


def test_each_chunkers_size_and_overlap_settings_say_their_role():
    roles = {
        use: {f: p["x-role"] for f, p in info["config_schema"]["properties"].items() if "x-role" in p}
        for use, info in pandion.catalog()["chunk"].items()
    }
    assert roles["recursive_character"] == {"chunk_size": "size", "chunk_overlap": "overlap"}
    assert roles["token_based"] == {"max_tokens": "size", "overlap": "overlap"}
    assert roles["sentence_window"] == {"sentences_per_chunk": "size", "overlap_sentences": "overlap"}
    # Every chunker has exactly one size setting.
    assert all(list(r.values()).count("size") == 1 for r in roles.values())


def test_evaluate_and_compare_check_as_many_pieces_as_the_eval_step_by_default(monkeypatch):
    import inspect

    from pandion import cli

    from pandion.evaluation import DEFAULT_TOP_K, compare, evaluate

    eval_default = pandion.catalog()["use_case"]["eval"]["config_schema"]["properties"]["top_k"]["default"]
    assert DEFAULT_TOP_K == eval_default
    assert inspect.signature(evaluate).parameters["top_k"].default == DEFAULT_TOP_K
    assert inspect.signature(compare).parameters["top_k"].default == DEFAULT_TOP_K

    # The CLI's eval and compare follow it too, in their defaults and in what --help says.
    monkeypatch.setattr(cli, "DEFAULT_TOP_K", 7, raising=False)
    for argv in (["eval", "p.yaml", "qs.json"], ["compare", "p.yaml", "--vary", "chunk.chunk_size=1,2", "docs"]):
        assert cli.parser().parse_args(argv).top_k == 7
    subs = next(a for a in cli.parser()._actions if a.dest == "command").choices
    for name in ("eval", "compare"):
        top_k = next(a for a in subs[name]._actions if a.dest == "top_k")
        assert "(default 7)" in top_k.help
