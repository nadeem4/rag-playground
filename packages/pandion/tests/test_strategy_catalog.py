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
