"""Run one stage on its own: `pandion.parse` on one file, `pandion.clean` on one document."""

from __future__ import annotations

from pathlib import Path

import pytest

import pandion
from pandion.payloads import Element, ParsedDoc
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


# --- pandion.clean ----------------------------------------------------------


def notice_doc() -> ParsedDoc:
    """The same notice twice, between two ordinary paragraphs."""
    texts = ["Intro.", "Notice: read this.", "Body.", "Notice: read this."]
    return ParsedDoc(
        source_id="d" * 64,
        filename="notice.pdf",
        elements=[
            Element(id=f"e{i}", type="paragraph", text=t, order=i, page=1)
            for i, t in enumerate(texts)
        ],
    )


def test_clean_runs_the_steps_in_the_order_given():
    dedupe_first = pandion.clean(
        notice_doc(),
        steps=[{"use": "dedupe_blocks"}, {"use": "drop_matching", "pattern": "notice"}],
    )
    drop_first = pandion.clean(
        notice_doc(),
        steps=[{"use": "drop_matching", "pattern": "notice"}, {"use": "dedupe_blocks"}],
    )

    # Both orders end with the same text, but each step saw a different document.
    assert [e.text for e in dedupe_first.output.elements] == ["Intro.", "Body."]
    assert [e.text for e in drop_first.output.elements] == ["Intro.", "Body."]
    assert dedupe_first.note.splitlines() == [
        "dedupe_blocks: Removed 1 block: 1 paragraph from page 1 that repeats one from page 1.",
        "drop_matching: Removed 1 block: 1 paragraph on page 1 that matched the pattern.",
    ]
    assert drop_first.note.splitlines() == [
        "drop_matching: Removed 2 blocks: 2 paragraphs on page 1 that matched the pattern.",
        "dedupe_blocks: Removed 0 blocks. No two blocks had the same text.",
    ]


def test_clean_returns_a_stage_result():
    result = pandion.clean(notice_doc(), steps=[{"use": "dedupe_blocks"}])

    assert isinstance(result, pandion.StageResult)
    assert result.stage == "clean"
    assert result.transform == "dedupe_blocks"
    assert result.status == "executed"
    assert result.artifact_id is None
    assert isinstance(result.output, ParsedDoc)
    assert len(result.output.elements) == 3


def test_clean_takes_the_result_of_parse(sample_pdf: Path):
    parsed = pandion.parse(sample_pdf, use="pdfium", join_lines=False)

    result = pandion.clean(parsed, steps=[{"use": "dedupe_blocks"}])

    assert [e.text for e in result.output.elements] == SAMPLE_LINES


def test_clean_with_no_steps_returns_the_document_unchanged():
    doc = notice_doc()

    result = pandion.clean(doc, steps=[])

    assert result.output == doc
    assert result.note is None


def test_an_unknown_cleaner_is_an_error_naming_the_step():
    with pytest.raises(UnknownTransformError, match="step 2.*no_such_cleaner"):
        pandion.clean(
            notice_doc(), steps=[{"use": "dedupe_blocks"}, {"use": "no_such_cleaner"}]
        )


def test_a_step_without_use_is_an_error():
    with pytest.raises(ValueError, match="step 1"):
        pandion.clean(notice_doc(), steps=[{"pattern": "x"}])


def test_an_unknown_setting_is_an_error_naming_the_step():
    with pytest.raises(ValueError, match="step 1.*dedupe_blocks.*'threshold'"):
        pandion.clean(notice_doc(), steps=[{"use": "dedupe_blocks", "threshold": 0.9}])


def test_a_wrong_setting_value_is_an_error():
    with pytest.raises(ValueError):
        pandion.clean(notice_doc(), steps=[{"use": "dedupe_blocks", "scope": "sometimes"}])
