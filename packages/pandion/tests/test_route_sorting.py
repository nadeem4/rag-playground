"""Sorting documents by the route: reasons, the default, and errors at load."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
from pdfs import build_pdf
from pydantic import BaseModel

from pandion.config import ConfigError, RouteRule, from_dict, to_dict
from pandion.docinfo import DocumentInfo
from pandion.extend import ArtifactType, Element, ParsedDoc, PortSpec, Stage, Transform, register, route_check
from pandion.pipeline import Pipeline
from pandion.routing import CHECKS, Sorting, sort_document

PDF = {"use": "file_type", "types": ["pdf"]}
NO_TEXT = {"use": "text_layer", "has": False}


def info(**kw) -> DocumentInfo:
    base = dict(
        filename="a.pdf", type="pdf", size=1, path="", metadata={}, properties={},
        page_count=1, text_layer=True, first_page_text="",
    )
    return DocumentInfo(**{**base, **kw})


def rule(category, *checks) -> RouteRule:
    return RouteRule(category, when=[(c["use"], {k: v for k, v in c.items() if k != "use"}) for c in checks] or None)


def test_first_matching_rule_wins():
    route = [rule("a", PDF), rule("b", PDF), rule("c")]
    assert sort_document(route, info()) == Sorting("a", "Rule 1: type is pdf")


def test_all_checks_in_a_rule_must_be_true():
    route = [rule("scans", PDF, NO_TEXT), rule("text")]
    assert sort_document(route, info(text_layer=True)).category == "text"
    assert sort_document(route, info(text_layer=False)).category == "scans"


def test_reason_texts():
    route = [
        rule("scans", PDF, NO_TEXT),
        rule("legal", {"use": "path", "pattern": "legal/**"}),
        rule("other"),
    ]
    assert sort_document(route, info(path="legal/a/b.pdf")).reason == "Rule 2: path matches legal/**"
    assert sort_document(route, info(text_layer=False)).reason == "Rule 1: type is pdf and has no text layer"
    assert sort_document(route, info()).reason == "Default: no rule matched"
    assert sort_document(route, info(), pinned="legal") == Sorting("legal", "Chosen when added")


@pytest.fixture
def boom():
    @route_check("boom_check_b")
    def boom(info, settings):
        raise ValueError("boom")

    yield
    CHECKS.pop("boom_check_b")


def test_default_reason_names_a_failing_check(boom):
    route = [rule("a", {"use": "boom_check_b"}), rule("z")]
    assert sort_document(route, info()) == Sorting("z", "Default: no rule matched; boom_check_b failed: ValueError: boom")


def test_a_raising_check_is_false_and_the_run_goes_on(boom):
    route = [rule("a", {"use": "boom_check_b"}), rule("b", PDF), rule("z")]
    assert sort_document(route, info()).category == "b"


BASE = {
    "path": "idx",
    "categories": {
        "scans": {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"}},
        "legal": {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"}},
        "other": {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"}},
    },
    "route": [
        {"when": [PDF, NO_TEXT], "category": "scans"},
        {"when": {"use": "path", "pattern": "legal/**"}, "category": "legal"},
        {"category": "other"},
    ],
    "index": {"embed": {"use": "qwen3-embedding-0.6b"}, "store": {"use": "lancedb"}},
}


def with_route(*steps) -> dict:
    data = copy.deepcopy(BASE)
    data["route"] = [{"when": list(steps), "category": "legal"}, {"category": "other"}]
    return data


def test_unknown_check_is_refused_at_load():
    with pytest.raises(ConfigError, match=r"route\.1\.when\.2 uses 'nope', which is not a check. The checks are: contains, file_type") as e:
        from_dict(with_route(PDF, {"use": "nope"}), base=Path("."))
    assert e.value.step == "route.1.when.2" and e.value.use == "nope"


def test_check_settings_are_validated_at_load():
    with pytest.raises(ConfigError) as e:
        from_dict(with_route({"use": "metadata", "key": "k"}), base=Path("."))
    assert e.value.step == "route.1.when.1" and e.value.use == "metadata"
    assert "equals, contains, pattern" in str(e.value)
    with pytest.raises(ConfigError, match="has no setting 'typo'"):
        from_dict(with_route({"use": "file_type", "types": ["pdf"], "typo": 1}), base=Path("."))
    with pytest.raises(ConfigError) as e:
        from_dict(with_route({"use": "file_type"}), base=Path("."))
    assert [s["field"] for s in e.value.settings] == ["types"]


@pytest.fixture
def _forget_parser():
    yield
    from pandion.registry import registry

    registry._by_stage[Stage.PARSE].pop("test_route_lines", None)


class NoSettings(BaseModel):
    pass


def make_pipeline(tmp_path, route=None) -> Pipeline:
    @register
    class Lines(Transform[NoSettings]):
        name = "test_route_lines"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = NoSettings
        summary = "One block per line."

        def apply(self, inputs, config, ctx):
            text = Path(inputs["file"]["path"]).read_bytes().decode("utf-8", errors="ignore")
            return ParsedDoc(elements=[Element(id="l0", type="paragraph", text=text[:20], order=0)])

    data = copy.deepcopy(BASE)
    data["path"] = str(tmp_path / "idx")
    for c in data["categories"].values():
        c["parse"] = {"use": "test_route_lines"}
    if route:
        data["route"] = route
    return Pipeline.from_dict(data)


def test_pipeline_sorts_by_routes(tmp_path, _forget_parser):
    docs = tmp_path / "docs"
    (docs / "legal").mkdir(parents=True)
    (docs / "legal" / "a.pdf").write_bytes(build_pdf([["Hello there."]]))
    (docs / "scan.pdf").write_bytes(build_pdf([[]]))
    (docs / "page.html").write_text("<html><title>T</title></html>", encoding="utf-8")
    p = make_pipeline(tmp_path)
    report = p.index.run(docs, through="parse")
    got = {k: (d.category, d.reason) for k, d in report.documents.items()}
    assert got == {
        "legal/a.pdf": ("legal", "Rule 2: path matches legal/**"),
        "scan.pdf": ("scans", "Rule 1: type is pdf and has no text layer"),
        "page.html": ("other", "Default: no rule matched"),
    }


def test_pin_beats_routes(tmp_path, _forget_parser):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "scan.pdf").write_bytes(build_pdf([[]]))
    p = make_pipeline(tmp_path)
    report = p.index.run(docs, through="parse", categories={"scan.pdf": "legal"})
    assert report.documents["scan.pdf"].category == "legal"
    assert report.documents["scan.pdf"].reason == "Chosen when added"


def test_routes_with_when_round_trip_through_to_dict():
    data = copy.deepcopy(BASE)
    back = to_dict(from_dict(copy.deepcopy(data), base=Path(".")))
    assert back["route"][0]["when"] == [PDF, NO_TEXT]
    assert back["route"][1]["when"] == {"use": "path", "pattern": "legal/**"}


def test_no_rule_with_when_never_reads_the_files(tmp_path, _forget_parser, monkeypatch):
    import pandion.pipeline as pipeline

    def refuse(*a, **k):
        raise AssertionError("document_info was called")

    monkeypatch.setattr(pipeline, "document_info", refuse)
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "a.html").write_text("<html></html>", encoding="utf-8")
    p = make_pipeline(tmp_path, route=[{"category": "other"}])
    report = p.index.run(docs, through="parse")
    assert report.documents["a.html"].category == "other"


def test_a_failing_because_does_not_stop_the_run():
    def bad(settings):
        raise RuntimeError("no phrase")

    @route_check("odd_because", because=bad)
    def odd(info, settings):
        return True

    try:
        got = sort_document([rule("a", {"use": "odd_because"}), rule("z")], info())
    finally:
        CHECKS.pop("odd_because")
    assert got == Sorting("a", "Rule 1: odd_because true")


def test_whole_check_error_is_a_plain_sentence_with_fields():
    with pytest.raises(ConfigError) as e:
        from_dict(with_route({"use": "metadata", "key": "k"}), base=Path("."))
    assert str(e.value) == "route.1.when.1 (metadata): Give exactly one of equals, contains, pattern."
    assert [s["field"] for s in e.value.settings] == ["equals", "contains", "pattern"]
    assert all("exactly one" in s["message"] for s in e.value.settings)


def test_when_item_without_use_says_check():
    with pytest.raises(ConfigError, match="which check to use") as e:
        from_dict(with_route({"types": ["pdf"]}), base=Path("."))
    assert e.value.step == "route.1.when.1"


def test_explain_refuses_the_route_stage():
    import pandion

    with pytest.raises(ValueError, match="checks.*no explain"):
        pandion.explain("route", "file_type", {"types": ["pdf"]})
