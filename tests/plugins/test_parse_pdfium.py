"""`pdfium` is the deliberately-dumb text baseline.

With `join_lines=False` it must recover every line of the fixture, in reading
order, with the right page number, exactly as it always did. With the default
`join_lines=True` it rebuilds paragraphs from the vertical gaps between lines.
Either way it must NOT invent structure: heading detection is out of scope on
purpose, because the gap between this and a layout-aware parser is the Phase 3
lesson.
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

from tests.plugins.conftest import (
    SAMPLE_LINES,
    SAMPLE_PAGES,
    build_paragraph_pdf,
    build_pdf,
)


def parse(
    path: Path, sha: str = "a" * 64, filename: str = "sample.pdf", **config
) -> ParsedDoc:
    cls = registry.get(Stage.PARSE, "pdfium")
    payload = cls().apply(
        {"file": {"sha": sha, "filename": filename, "path": str(path),
                  "mime": "application/pdf"}},
        cls.config_model(**config),
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
    doc = parse(sample_pdf, join_lines=False)
    assert [e.text for e in doc.elements] == SAMPLE_LINES


def test_order_is_dense_and_ascending(sample_pdf: Path):
    doc = parse(sample_pdf, join_lines=False)
    assert [e.order for e in doc.elements] == list(range(len(SAMPLE_LINES)))


def test_pages_are_one_based_and_correct(sample_pdf: Path):
    doc = parse(sample_pdf, join_lines=False)
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
    doc = parse(sample_pdf, join_lines=False)
    markdown, offsets = doc.render_markdown()
    for element in doc.elements:
        start, end = offsets[element.id]
        assert markdown[start:end] == element.text
    for line in SAMPLE_LINES:
        assert line in markdown


def test_blank_pages_contribute_no_elements(tmp_path: Path):
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


# -- join_lines ---------------------------------------------------------------

#: Three paragraphs on page one, one on page two, laid out with real paragraph
#: spacing: a larger vertical gap between paragraphs than between lines.
PARAGRAPH_PAGES: list[list[list[str]]] = [
    [
        ["Chunking notes"],
        [
            "A retriever never sees a document. It sees",
            "chunks, and it can only return what a chunk",
            "contains.",
        ],
        [
            "Boundary placement is a recall decision",
            "disguised as a preprocessing step.",
        ],
    ],
    [
        [
            "Overlap protects answers that straddle a",
            "boundary, at the cost of storage.",
        ],
    ],
]


@pytest.fixture
def paragraph_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "paragraphs.pdf"
    path.write_bytes(build_paragraph_pdf(PARAGRAPH_PAGES))
    return path


def test_join_lines_defaults_to_true_and_bumps_the_version():
    cls = registry.get(Stage.PARSE, "pdfium")
    assert cls.config_model().join_lines is True
    assert cls.version == "2"


def test_join_lines_rebuilds_paragraphs_from_vertical_gaps(paragraph_pdf: Path):
    doc = parse(paragraph_pdf)
    assert [e.text for e in doc.elements] == [
        "Chunking notes",
        "A retriever never sees a document. It sees chunks, and it can only "
        "return what a chunk contains.",
        "Boundary placement is a recall decision disguised as a preprocessing step.",
        "Overlap protects answers that straddle a boundary, at the cost of storage.",
    ]


def test_a_multi_line_paragraph_becomes_one_element(paragraph_pdf: Path):
    doc = parse(paragraph_pdf)
    three_line = [e for e in doc.elements if e.text.startswith("A retriever")]
    assert len(three_line) == 1
    assert three_line[0].text.endswith("what a chunk contains.")


def test_paragraphs_are_never_merged_across_pages(tmp_path: Path):
    # Uniform pitch everywhere, so there is no gap anywhere: only the page break
    # separates the two pages' text.
    path = tmp_path / "flow.pdf"
    path.write_bytes(build_pdf([["first page line one", "first page line two"],
                                ["second page line one", "second page line two"]]))
    doc = parse(path)
    assert [(e.text, e.page) for e in doc.elements] == [
        ("first page line one first page line two", 1),
        ("second page line one second page line two", 2),
    ]


def test_merged_elements_keep_order_page_and_a_covering_bbox(paragraph_pdf: Path):
    doc = parse(paragraph_pdf)
    assert [e.order for e in doc.elements] == list(range(4))
    assert [e.id for e in doc.elements] == [f"e{i:05d}" for i in range(4)]
    assert [e.page for e in doc.elements] == [1, 1, 1, 2]
    assert all(e.type == "paragraph" and e.level is None for e in doc.elements)

    heading, three_line, two_line, _ = doc.elements
    for e in doc.elements:
        left, bottom, right, top = e.bbox
        assert left < right and bottom < top
    # A three-line paragraph is roughly three pitches tall, a heading one line.
    assert three_line.bbox[3] - three_line.bbox[1] > 2.5 * (heading.bbox[3] - heading.bbox[1])
    # Reading order runs down the page, and PDF y grows upwards.
    assert heading.bbox[1] > three_line.bbox[3] > two_line.bbox[3]


def test_join_lines_off_reproduces_the_line_per_element_output(sample_pdf: Path):
    doc = parse(sample_pdf, join_lines=False)
    expected = []
    for page_no, lines in enumerate(SAMPLE_PAGES, start=1):
        for line in lines:
            order = len(expected)
            expected.append({
                "id": f"e{order:05d}", "type": "paragraph", "text": line,
                "order": order, "parent_id": None, "page": page_no, "bbox": None,
                "level": None, "md_start": None, "md_end": None,
            })
    assert doc.model_dump(mode="json") == {
        "elements": expected,
        "page_count": len(SAMPLE_PAGES),
        "source_id": "a" * 64,
        "filename": "sample.pdf",
        "doc_meta": {},
        "parser_meta": {"parser": "pdfium", "mode": "text"},
    }


def test_join_lines_off_splits_a_paragraph_pdf_into_lines(paragraph_pdf: Path):
    doc = parse(paragraph_pdf, join_lines=False)
    assert [e.text for e in doc.elements] == [
        line for page in PARAGRAPH_PAGES for para in page for line in para
    ]


@pytest.mark.parametrize(
    ("lines", "joined"),
    [
        # A letter, a hyphen, a lowercase continuation: a word the line broke.
        (["The parser rebuilds para-", "graphs from layout."],
         "The parser rebuilds paragraphs from layout."),
        # An uppercase continuation is not clearly a broken word.
        (["Built on the pdfium-", "Based extractor."],
         "Built on the pdfium- Based extractor."),
        # A spaced dash is punctuation.
        (["Cheap and fast -", "but blind to structure."],
         "Cheap and fast - but blind to structure."),
        # A digit before the hyphen is not a word break.
        (["Published in 2019-", "2020 editions."],
         "Published in 2019- 2020 editions."),
    ],
)
def test_hyphenation_is_repaired_only_at_a_real_word_break(
    tmp_path: Path, lines: list[str], joined: str
):
    path = tmp_path / "hyphen.pdf"
    path.write_bytes(build_paragraph_pdf([[lines]]))
    assert [e.text for e in parse(path).elements] == [joined]
