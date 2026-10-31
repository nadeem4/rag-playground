"""Route checks: the seven built in, the registry, and writing your own."""

from __future__ import annotations

import sys

import pytest
from pydantic import BaseModel, ValidationError

import pandion
from pandion.docinfo import DocumentInfo
from pandion.extend import route_check
from pandion.plugins import discover
from pandion.registry import DuplicateTransformError
from pandion.routing import CHECKS, check_catalog, run_check

discover()

SEVEN = {"file_type", "name", "path", "metadata", "properties", "text_layer", "contains"}


def info(**kw) -> DocumentInfo:
    base = dict(
        filename="Report.PDF", type="pdf", size=10, path="Legal/A/B.pdf", metadata={"Team": "Law"},
        properties={"Author": "Ada Lovelace"}, page_count=2, text_layer=True, first_page_text="Hello Invoice",
    )
    return DocumentInfo(**{**base, **kw})


def passes(use, settings, **kw):
    result, error = run_check(use, settings, info(**kw))
    assert error is None
    return result


@pytest.mark.parametrize(
    ("use", "settings", "kw", "expected"),
    [
        ("file_type", {"types": ["pdf", "docx"]}, {}, True),
        ("file_type", {"types": ["docx"]}, {}, False),
        ("name", {"pattern": "report.*"}, {}, True),
        ("name", {"pattern": "memo*"}, {}, False),
        ("path", {"pattern": "legal/**"}, {}, True),
        ("path", {"pattern": "legal/*"}, {}, True),
        ("path", {"pattern": "tax/**"}, {}, False),
        ("metadata", {"key": "team", "equals": "law"}, {}, True),
        ("metadata", {"key": "team", "contains": "a"}, {}, True),
        ("metadata", {"key": "team", "pattern": "l*"}, {}, True),
        ("metadata", {"key": "team", "equals": "tax"}, {}, False),
        ("properties", {"key": "author", "contains": "LOVELACE"}, {}, True),
        ("properties", {"key": "Author", "equals": "Grace"}, {}, False),
        ("text_layer", {"has": True}, {}, True),
        ("text_layer", {"has": False}, {}, False),
        ("text_layer", {"has": False}, {"text_layer": False}, True),
        ("contains", {"words": ["invoice", "receipt"]}, {}, True),
        ("contains", {"words": ["receipt"]}, {}, False),
    ],
)
def test_each_check_true_and_false(use, settings, kw, expected):
    assert passes(use, settings, **kw) is expected


def test_matching_ignores_case():
    assert passes("name", {"pattern": "REPORT.pdf"})
    assert passes("path", {"pattern": "LEGAL/**"})
    assert passes("metadata", {"key": "TEAM", "equals": "LAW"})
    assert passes("properties", {"key": "AUTHOR", "equals": "ADA LOVELACE"})
    assert passes("contains", {"words": ["INVOICE"]})


def test_missing_key_and_missing_property_are_false():
    assert not passes("metadata", {"key": "nope", "equals": "x"})
    assert not passes("properties", {"key": "nope", "contains": "x"})
    assert not passes("path", {"pattern": "*"}, path="")


def test_check_that_does_not_apply_is_false():
    assert not passes("text_layer", {"has": True}, type="docx", text_layer=None)
    assert not passes("contains", {"words": ["x"]}, type="png", first_page_text="")


@pytest.mark.parametrize("has", [True, False])
def test_text_layer_none_is_false_for_both_has_values(has):
    assert not passes("text_layer", {"has": has}, text_layer=None)


@pytest.mark.parametrize("use", ["metadata", "properties"])
@pytest.mark.parametrize("operators", [{}, {"equals": "a", "contains": "b"}])
def test_metadata_needs_exactly_one_operator(use, operators):
    with pytest.raises(ValidationError, match="equals, contains, pattern"):
        CHECKS[use].config_model(key="k", **operators)


def test_run_check_catches_an_error():
    @route_check("boom_check_a")
    def boom(info, settings):
        raise ValueError("boom")

    try:
        assert run_check("boom_check_a", {}, info()) == (False, "ValueError: boom")
    finally:
        CHECKS.pop("boom_check_a")


def test_duplicate_name_is_refused():
    with pytest.raises(DuplicateTransformError, match="route/file_type is already registered"):
        route_check("file_type")(lambda info, settings: True)


def test_check_catalog_has_the_seven_and_their_schema():
    catalog = check_catalog()
    assert SEVEN <= set(catalog)
    entry = catalog["file_type"]
    assert entry["name"] == "file_type" and entry["stage"] == "route" and entry["learn"] is None
    assert entry["summary"]
    assert "types" in entry["config_schema"]["properties"]


def test_pandion_catalog_has_a_route_stage():
    assert SEVEN <= set(pandion.catalog()["route"])


def test_own_check_loads_through_plugins(tmp_path, monkeypatch):
    (tmp_path / "my_rules.py").write_text(
        "from pydantic import BaseModel\n"
        "from pandion.extend import route_check\n"
        "class Prefix(BaseModel):\n    prefix: str = 'INV'\n"
        "@route_check('is_invoice', summary='Name starts with a prefix.', config=Prefix)\n"
        "def is_invoice(info, settings):\n    return info.filename.startswith(settings.prefix)\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        p = pandion.Pipeline.from_dict(
            {
                "plugins": ["my_rules"],
                "path": str(tmp_path / "idx"),
                "categories": {
                    "bills": {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"}},
                    "other": {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"}},
                },
                "route": [{"when": {"use": "is_invoice"}, "category": "bills"}, {"category": "other"}],
                "index": {"embed": {"use": "qwen3-embedding-0.6b"}, "store": {"use": "lancedb"}},
            }
        )
        assert p.config.index.route[0].when == [("is_invoice", {})]
        assert run_check("is_invoice", {"prefix": "INV"}, info()) == (False, None)
        assert run_check("is_invoice", {}, info(filename="INV1.pdf")) == (True, None)
    finally:
        CHECKS.pop("is_invoice", None)
        sys.modules.pop("my_rules", None)
