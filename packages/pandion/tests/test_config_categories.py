"""Categories and routes in the pipeline file: reading, writing, and the recipe hash."""

from __future__ import annotations

import copy
from dataclasses import replace

import pytest

from pandion.config import ConfigError, RouteRule, from_dict, to_dict
from pandion.manifest import recipe_hash

OLD = {
    "path": "idx",
    "index": {
        "parse": {"use": "pdfium"},
        "clean": [{"use": "dedupe_blocks"}],
        "chunk": {"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 80},
        "embed": {"use": "qwen3-embedding-0.6b"},
        "store": {"use": "lancedb", "metric": "cosine", "build_fts": True},
    },
}

#: recipe_hash of OLD's index, taken on main before categories existed.
OLD_HASH = "3d056348b31b913085f392c710aed4c742c7734d47195b0a3c4dff69316a1f4f"

NEW = {
    "path": "idx",
    "categories": {
        "reports": {
            "name": "Reports with tables",
            "template": "tables",
            "parse": {"use": "docling", "do_table_structure": True},
            "clean": [{"use": "dedupe_blocks"}],
            "chunk": {"use": "layout_blocks", "max_tokens": 400},
        },
        "scans": {
            "name": "Scanned PDFs",
            "parse": {"use": "docling", "do_ocr": True},
            "chunk": {"use": "layout_blocks", "max_tokens": 300},
        },
        "text": {
            "parse": {"use": "pdfium"},
            "chunk": {"use": "recursive_character", "chunk_size": 400},
        },
    },
    "route": [
        {"when": {"use": "metadata", "key": "cms_type", "equals": "invoice"}, "category": "reports"},
        {
            "when": [{"use": "file_type", "types": ["pdf"]}, {"use": "text_layer", "has": False}],
            "category": "scans",
        },
        {"category": "text"},
    ],
    "index": {
        "embed": {"use": "qwen3-embedding-0.6b"},
        "store": {"use": "lancedb", "metric": "cosine", "build_fts": True},
    },
}


def read(data, tmp_path):
    return from_dict(copy.deepcopy(data), base=tmp_path)


def edited(**changes):
    data = copy.deepcopy(NEW)
    for key, value in changes.items():
        data[key] = value
    return data


def test_old_file_reads_as_one_default_category(tmp_path):
    index = read(OLD, tmp_path).index
    assert list(index.categories) == ["default"]
    assert index.categories["default"].name == "Default"
    assert index.categories["default"].template is None
    assert index.route == [RouteRule(category="default")]
    assert index.legacy is True


def test_categories_file_reads(tmp_path):
    index = read(NEW, tmp_path).index
    assert index.legacy is False
    assert list(index.categories) == ["reports", "scans", "text"]
    assert index.categories["reports"].parse == ("docling", {"do_table_structure": True})
    assert index.categories["reports"].template == "tables"
    assert index.route[0].category == "reports"
    assert index.route[0].when == [("metadata", {"key": "cms_type", "equals": "invoice"})]
    assert len(index.route[1].when) == 2
    assert index.route[2].when is None


def test_route_must_end_with_a_rule_without_when(tmp_path):
    route = [NEW["route"][0]]
    with pytest.raises(ConfigError, match="last rule") as info:
        read(edited(route=route), tmp_path)
    assert info.value.step == "route"


def test_route_naming_a_missing_category_is_refused(tmp_path):
    route = [NEW["route"][0], {"category": "scans2"}]
    data = edited(route=route)
    del data["categories"]["scans"]
    route[1]["category"] = "scans"
    with pytest.raises(ConfigError) as info:
        read(data, tmp_path)
    assert "'scans'" in str(info.value) and "route.2" in str(info.value)


def test_a_rule_without_when_before_the_end_is_refused(tmp_path):
    route = [{"category": "reports"}, {"category": "text"}]
    with pytest.raises(ConfigError, match=r"Rule 1.*can never run"):
        read(edited(route=route), tmp_path)


def test_index_parse_with_categories_is_refused(tmp_path):
    data = edited()
    data["index"]["parse"] = {"use": "pdfium"}
    with pytest.raises(ConfigError, match="one or the other"):
        read(data, tmp_path)


@pytest.mark.parametrize("missing", ["parse", "chunk"])
def test_category_needs_parse_and_chunk(tmp_path, missing):
    data = edited()
    del data["categories"]["scans"][missing]
    with pytest.raises(ConfigError, match=f"categories.scans has no {missing}"):
        read(data, tmp_path)


def test_category_with_embed_is_refused(tmp_path):
    data = edited()
    data["categories"]["scans"]["embed"] = {"use": "qwen3-embedding-0.6b"}
    with pytest.raises(ConfigError, match="embed belongs under index"):
        read(data, tmp_path)


def test_unknown_category_key_lists_valid_keys(tmp_path):
    data = edited()
    data["categories"]["scans"]["colour"] = "red"
    with pytest.raises(ConfigError, match="'colour'.*name, template, parse, clean, chunk"):
        read(data, tmp_path)


def test_category_step_errors_name_their_place(tmp_path):
    data = edited()
    data["categories"]["reports"]["chunk"] = {"use": "layout_blocks", "nope": 1}
    with pytest.raises(ConfigError) as info:
        read(data, tmp_path)
    assert info.value.step == "categories.reports.chunk"

    data = edited()
    data["categories"]["reports"]["clean"] = [{"use": "dedupe_blocks"}, {"use": "dedupe_blocks", "nope": 1}]
    with pytest.raises(ConfigError) as info:
        read(data, tmp_path)
    assert info.value.step == "categories.reports.clean.2"
    assert "clean step 2" in str(info.value)


def test_old_file_to_dict_is_unchanged(tmp_path):
    assert to_dict(read(OLD, tmp_path)) == {**OLD, "path": (tmp_path / "idx").as_posix()}


def test_categories_file_round_trips(tmp_path):
    out = to_dict(read(NEW, tmp_path))
    assert list(out) == ["path", "categories", "route", "index"]
    assert out == {**NEW, "path": (tmp_path / "idx").as_posix()}
    assert to_dict(from_dict(out, base=tmp_path)) == out


def test_old_file_recipe_hash_is_unchanged(tmp_path):
    assert recipe_hash(read(OLD, tmp_path).index) == OLD_HASH


def test_recipe_hash_ignores_routes_names_and_templates(tmp_path):
    index = read(NEW, tmp_path).index
    other = read(
        edited(route=[{"category": "text"}]),
        tmp_path,
    ).index
    renamed = copy.deepcopy(index)
    renamed.categories["reports"] = replace(renamed.categories["reports"], name="Other", template=None)
    assert recipe_hash(index) == recipe_hash(other) == recipe_hash(renamed)


def test_recipe_hash_changes_with_a_category_setting(tmp_path):
    data = edited()
    data["categories"]["reports"]["chunk"]["max_tokens"] = 200
    assert recipe_hash(read(NEW, tmp_path).index) != recipe_hash(read(data, tmp_path).index)
