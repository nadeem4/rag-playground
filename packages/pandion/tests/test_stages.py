"""Run one stage on its own: `pandion.parse` on one file, and `pandion.clean`
and `pandion.chunk` on one document."""

from __future__ import annotations

from pathlib import Path

import pytest

import pandion
from pandion.payloads import ChunkSet, Element, ParsedDoc
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


def test_an_unknown_parse_setting_is_an_error_naming_the_parser(sample_pdf: Path):
    with pytest.raises(ValueError, match="pdfium.*'no_such_setting'.*join_lines"):
        pandion.parse(sample_pdf, use="pdfium", no_such_setting=1)


def test_an_unknown_parser_lists_the_parsers(sample_pdf: Path):
    with pytest.raises(UnknownTransformError, match="no-such-parser.*docling.*pdfium"):
        pandion.parse(sample_pdf, use="no-such-parser")


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


# --- pandion.chunk ----------------------------------------------------------

CHUNKERS = [
    "recursive_character",
    "layout_blocks",
    "markdown_header",
    "token_based",
    "sentence_window",
]


@pytest.mark.parametrize("use", CHUNKERS)
def test_chunk_runs_one_chunker_on_one_document(use):
    result = pandion.chunk(notice_doc(), use=use)

    assert isinstance(result, pandion.StageResult)
    assert result.stage == "chunk"
    assert result.transform == use
    assert result.status == "executed"
    assert result.artifact_id is None
    assert result.duration_ms >= 0
    assert isinstance(result.output, ChunkSet)
    assert result.output.chunks
    assert "Intro." in result.output.chunks[0].text


def test_chunk_passes_the_settings_to_the_chunker():
    doc = ParsedDoc(
        source_id="e" * 64,
        filename="long.pdf",
        elements=[
            Element(id=f"e{i}", type="paragraph", text=f"Paragraph {i} has some words.", order=i)
            for i in range(20)
        ],
    )

    small = pandion.chunk(doc, use="recursive_character", chunk_size=60, chunk_overlap=0)
    large = pandion.chunk(doc, use="recursive_character", chunk_size=2000, chunk_overlap=0)

    assert len(small.output.chunks) > len(large.output.chunks) == 1


def test_chunk_takes_the_result_of_parse_or_clean(sample_pdf: Path):
    parsed = pandion.parse(sample_pdf, use="pdfium", join_lines=False)
    cleaned = pandion.clean(parsed, steps=[{"use": "dedupe_blocks"}])
    settings = {"sentences_per_chunk": 1, "overlap_sentences": 0}

    from_parse = pandion.chunk(parsed, use="sentence_window", **settings)
    from_clean = pandion.chunk(cleaned, use="sentence_window", **settings)

    assert [c.text for c in from_parse.output.chunks] == SAMPLE_LINES
    assert [c.text for c in from_clean.output.chunks] == SAMPLE_LINES


def test_chunk_keeps_the_chunkers_note():
    result = pandion.chunk(
        notice_doc(), use="sentence_window", sentences_per_chunk=2, overlap_sentences=1
    )

    assert result.note == (
        "Cut 4 sentences into 3 pieces of up to 2 sentences, 1 shared between neighbours."
    )


def test_an_unknown_chunker_lists_the_chunkers():
    with pytest.raises(UnknownTransformError, match="no_such_chunker.*layout_blocks.*token_based"):
        pandion.chunk(notice_doc(), use="no_such_chunker")


def test_an_unknown_chunk_setting_is_an_error_naming_the_chunker():
    with pytest.raises(ValueError, match="recursive_character.*'size'.*chunk_size"):
        pandion.chunk(notice_doc(), use="recursive_character", size=400)


def test_a_wrong_chunk_setting_value_is_an_error():
    with pytest.raises(ValueError):
        pandion.chunk(
            notice_doc(), use="sentence_window", sentences_per_chunk=2, overlap_sentences=2
        )
