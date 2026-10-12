"""Run one stage on its own: `pandion.parse` on one file."""

from __future__ import annotations

from pathlib import Path

import pytest

import pandion
from pandion.payloads import ParsedDoc
from pandion.registry import UnknownTransformError
from pdfs import SAMPLE_LINES


def test_parse_runs_one_parser_on_one_file(sample_pdf: Path):
    result = pandion.parse(sample_pdf, use="pdfium", join_lines=False)

    assert isinstance(result, pandion.StageResult)
    assert result.stage == "parse"
    assert result.transform == "pdfium"
    assert result.status == "executed"
    assert result.artifact_id is None
    assert result.duration_ms >= 0
    assert isinstance(result.output, ParsedDoc)
    assert [e.text for e in result.output.elements] == SAMPLE_LINES
    assert result.output.filename == "sample.pdf"
    assert len(result.output.source_id) == 64


def test_parse_takes_a_string_path(sample_pdf: Path):
    assert pandion.parse(str(sample_pdf), use="pdfium").output.page_count == 3


def test_an_unknown_parser_is_an_error(sample_pdf: Path):
    with pytest.raises(UnknownTransformError):
        pandion.parse(sample_pdf, use="no-such-parser")


def test_a_wrong_setting_is_an_error(sample_pdf: Path):
    with pytest.raises(ValueError):
        pandion.parse(sample_pdf, use="pdfium", join_lines="sometimes")
