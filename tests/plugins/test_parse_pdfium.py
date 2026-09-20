"""`pdfium` is the deliberately-dumb text baseline.

It must recover every line of the fixture, in reading order, with the right page
number — and it must NOT invent structure. Heading detection is out of scope on
purpose: the gap between this and a layout-aware parser is the Phase 3 lesson.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from core.artifacts import ArtifactType
from core.payloads import ParsedDoc
from core.ports import Stage
from core.registry import registry

import plugins.parse.pdfium  # noqa: F401  (registers the transform)

from tests.plugins.conftest import SAMPLE_LINES, SAMPLE_PAGES


def parse(path: Path, sha: str = "a" * 64, filename: str = "sample.pdf") -> ParsedDoc:
    cls = registry.get(Stage.PARSE, "pdfium")
    payload = cls().apply(
        {"file": {"sha": sha, "filename": filename, "path": str(path),
                  "mime": "application/pdf"}},
        cls.config_model(),
        None,
    )
    assert isinstance(payload, dict), "payload must be JSON-ready"
    return ParsedDoc(**payload)


def test_registered_under_the_parse_stage():
    cls = registry.get(Stage.PARSE, "pdfium")
    assert cls.output is ArtifactType.PARSED_DOC
    assert set(cls.inputs) == {"file"}
    assert cls.inputs["file"].type is ArtifactType.RAW_FILE


def test_recovers_every_line_in_reading_order(sample_pdf: Path):
    doc = parse(sample_pdf)
    assert [e.text for e in doc.elements] == SAMPLE_LINES


def test_order_is_dense_and_ascending(sample_pdf: Path):
    doc = parse(sample_pdf)
    assert [e.order for e in doc.elements] == list(range(len(SAMPLE_LINES)))


def test_pages_are_one_based_and_correct(sample_pdf: Path):
    doc = parse(sample_pdf)
    expected = [i for i, page in enumerate(SAMPLE_PAGES, start=1) for _ in page]
    assert [e.page for e in doc.elements] == expected
    assert doc.page_count == len(SAMPLE_PAGES)


def test_every_element_is_a_paragraph(sample_pdf: Path):
    # No heading detection. If this ever fails, someone taught the dumb
    # baseline to guess, and the Phase 3 comparison stops meaning anything.
    doc = parse(sample_pdf)
    assert {e.type for e in doc.elements} == {"paragraph"}
    assert all(e.level is None for e in doc.elements)


def test_element_ids_are_unique_and_deterministic(sample_pdf: Path):
    first = parse(sample_pdf)
    second = parse(sample_pdf)
    ids = [e.id for e in first.elements]
    assert len(set(ids)) == len(ids)
    assert ids == [e.id for e in second.elements]


def test_carries_source_identity(sample_pdf: Path):
    doc = parse(sample_pdf, sha="b" * 64, filename="paper.pdf")
    assert doc.source_id == "b" * 64
    assert doc.filename == "paper.pdf"
    assert doc.parser_meta["parser"] == "pdfium"


def test_markdown_projection_round_trips(sample_pdf: Path):
    doc = parse(sample_pdf)
    markdown, offsets = doc.render_markdown()
    for element in doc.elements:
        start, end = offsets[element.id]
        assert markdown[start:end] == element.text
    for line in SAMPLE_LINES:
        assert line in markdown


def test_blank_pages_contribute_no_elements(tmp_path: Path):
    from tests.plugins.conftest import build_pdf

    path = tmp_path / "gap.pdf"
    path.write_bytes(build_pdf([["Only line."], []]))
    doc = parse(path)
    assert [e.text for e in doc.elements] == ["Only line."]
    assert doc.page_count == 2


def test_a_non_pdf_raises(tmp_path: Path):
    path = tmp_path / "not.pdf"
    path.write_bytes(b"this is not a pdf")
    with pytest.raises(Exception):
        parse(path)
