"""Documents beyond PDFs: Word, PowerPoint, HTML, Markdown, text and images.

Each parser declares the formats it reads in `provides["formats"]`, and a
pipeline refuses a file its parser cannot read before any step runs. Docling
reads every format here; Word, HTML, Markdown and text need no model, so those
conversions run in the fast suite. An image is read with OCR, which loads
models, so that test is marked `models`.

Documents without pages (Word, HTML, Markdown, text) have `page_count` 0, and
every element has no page and no box, so every piece has `page_span` None.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest

import pandion
from pandion import Pipeline
from pandion.ids import compute_artifact_id
from pandion.payloads import ParsedDoc
from pandion.ports import Stage
from pandion.registry import registry

DOCLING_FORMATS = ["pdf", "docx", "pptx", "html", "md", "txt", "png", "jpg"]

HTML = (
    "<html><head><title>Care guide</title></head><body>"
    "<h1>Ferns</h1><p>Ferns need water weekly.</p>"
    "<h2>Light</h2><p>Ferns like deep shade.</p>"
    "<h3>Winter</h3><p>Water less in winter.</p>"
    "</body></html>"
)
MARKDOWN = (
    "# Ferns\n\nFerns need water weekly.\n\n## Light\n\nFerns like deep shade.\n\n"
    "### Winter\n\nWater less in winter.\n"
)


def docx_bytes() -> bytes:
    docx = pytest.importorskip("docx", reason="python-docx builds the Word file")
    document = docx.Document()
    document.add_heading("Ferns", 1)
    document.add_paragraph("Ferns need water weekly.")
    document.add_heading("Light", 2)
    document.add_paragraph("Ferns like deep shade.")
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


def pptx_bytes() -> bytes:
    pptx = pytest.importorskip("pptx", reason="python-pptx builds the PowerPoint file")
    deck = pptx.Presentation()
    for title, body in [("Ferns", "Ferns need water weekly."), ("Light", "Ferns like deep shade.")]:
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = title
        slide.placeholders[1].text = body
    out = io.BytesIO()
    deck.save(out)
    return out.getvalue()


def png_bytes() -> bytes:
    image_module = pytest.importorskip("PIL.Image", reason="Pillow draws the image")
    from PIL import ImageDraw, ImageFont

    image = image_module.new("RGB", (900, 300), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=48)
    draw.text((40, 60), "Ferns need water weekly.", fill="black", font=font)
    draw.text((40, 160), "They like deep shade.", fill="black", font=font)
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def parse(path: Path, **config) -> ParsedDoc:
    pytest.importorskip("docling", reason="the docling extra reads these formats")
    return pandion.parse(path, use="docling", **config).output


def headings(doc: ParsedDoc) -> list[tuple[str, int | None]]:
    return [(e.text, e.level) for e in doc.elements if e.type == "heading"]


def assert_pageless(doc: ParsedDoc) -> None:
    assert doc.page_count == 0
    assert all(e.page is None and e.bbox is None for e in doc.elements)


# -- declared formats ----------------------------------------------------------


def test_pdfium_reads_pdf_only():
    assert registry.get(Stage.PARSE, "pdfium").provides == {"formats": ["pdf"]}


def test_docling_declares_every_format_it_reads():
    assert registry.get(Stage.PARSE, "docling").provides == {
        "structure": ["headings"],
        "formats": DOCLING_FORMATS,
    }


def test_docling_allows_only_its_declared_formats():
    pytest.importorskip("docling")
    from docling.datamodel.base_models import InputFormat

    import pandion.plugins.parse.docling as docling_plugin

    assert set(docling_plugin.allowed_formats()) == {
        InputFormat.PDF, InputFormat.DOCX, InputFormat.PPTX,
        InputFormat.HTML, InputFormat.MD, InputFormat.IMAGE,
    }


def test_an_image_is_read_with_ocr_even_when_ocr_is_off_for_pdfs():
    pytest.importorskip("docling")
    from docling.datamodel.base_models import InputFormat

    import pandion.plugins.parse.docling as docling_plugin

    options = docling_plugin.format_options(docling_plugin.DoclingConfig(do_ocr=False))
    assert options[InputFormat.PDF].pipeline_options.do_ocr is False
    assert options[InputFormat.IMAGE].pipeline_options.do_ocr is True


def test_a_docling_pdf_recipe_keeps_its_id():
    """Declaring formats changes nothing a PDF result id is made of."""
    cls = registry.get(Stage.PARSE, "docling")
    assert cls.version == "4"
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint="docling=2.129.0;docling-ibm-models=4.0.3",
        output_type=cls.output,
        config=cls.config_model().model_dump(mode="json"),
        inputs={"file": "a" * 64},
    ) == "98ca71177faae0d9d94bb8ba466bd2de1b9b7e6a0c24ff9472be74747eabeb99"


# -- the suffix check ----------------------------------------------------------


def _pipeline(tmp_path: Path, parse: str = "pdfium", chunk: dict | None = None) -> Pipeline:
    return Pipeline(
        path=tmp_path / "index",
        parse=parse,
        chunk=chunk or {"use": "recursive_character", "chunk_size": 200, "chunk_overlap": 0},
        embed="fake-deterministic",
        store="lancedb",
        search={"use": "hybrid_rrf", "top_k": 3},
    )


def test_pdfium_given_a_word_file_says_to_use_docling_before_any_work(tmp_path):
    notes = tmp_path / "notes.docx"
    notes.write_bytes(b"not really a word file")
    p = _pipeline(tmp_path)

    with pytest.raises(ValueError) as caught:
        p.index.run(notes)

    assert str(caught.value) == "pdfium reads PDF files; notes.docx is a Word file. Use docling."
    store = tmp_path / "index" / "artifacts"
    assert not store.exists() or not any(p for p in store.rglob("*") if p.is_file())


def test_a_format_no_parser_reads_names_what_the_parser_reads(tmp_path):
    sheet = tmp_path / "data.xlsx"
    sheet.write_bytes(b"cells")
    p = _pipeline(tmp_path, parse="docling")

    with pytest.raises(ValueError) as caught:
        p.index.run(sheet)

    assert str(caught.value) == (
        "docling reads PDF, Word, PowerPoint, HTML, Markdown, text, PNG and JPG files; "
        "data.xlsx is not one of them."
    )


def test_an_unreadable_file_raises_its_own_value_error():
    from pandion.formats import UnreadableFormat, check_readable

    assert issubclass(UnreadableFormat, ValueError)
    with pytest.raises(UnreadableFormat):
        check_readable("pdfium", "notes.docx")
    with pytest.raises(UnreadableFormat):
        check_readable("docling", "data.xlsx")


def test_a_pdf_named_as_markdown_is_refused_before_any_step_runs(tmp_path, monkeypatch):
    from pdfs import build_pdf

    from pandion.plugins.parse.docling import DoclingParse

    monkeypatch.setattr(DoclingParse, "apply", lambda *a, **k: (_ for _ in ()).throw(AssertionError("parsed")))
    notes = tmp_path / "notes.md"
    notes.write_bytes(build_pdf([["A PDF in disguise."]]))
    p = _pipeline(tmp_path, parse="docling")

    with pytest.raises(pandion.formats.UnreadableFormat) as caught:
        p.index.run(notes)

    assert str(caught.value) == "this file is named .md but holds a PDF"
    store = tmp_path / "index" / "artifacts"
    assert not store.exists() or not any(p for p in store.rglob("*") if p.is_file())


@pytest.mark.parametrize(
    ("name", "data", "held"),
    [
        ("notes.txt", b"\x89PNG\r\n\x1a\n" + bytes(64), "an image"),
        ("notes.docx", b"%PDF-1.7\n", "a PDF"),
    ],
)
def test_disguised_names_what_a_text_or_office_file_really_holds(tmp_path, name, data, held):
    from pandion.formats import disguised

    path = tmp_path / name
    path.write_bytes(data)
    assert disguised(path) == held


def test_a_file_that_is_what_its_name_says_is_not_disguised(tmp_path):
    from pandion.formats import disguised

    (tmp_path / "notes.md").write_text("# Notes\n\nPlain text.\n")
    (tmp_path / "report.pdf").write_bytes(b"%PDF-1.7\n")
    assert disguised(tmp_path / "notes.md") is None
    assert disguised(tmp_path / "report.pdf") is None


def test_the_suffix_is_matched_without_case(tmp_path):
    from pandion.formats import check_readable

    check_readable("pdfium", "REPORT.PDF")
    check_readable("docling", "photo.JPEG")
    check_readable("docling", "page.htm")


def test_parse_on_its_own_checks_the_suffix_too(tmp_path):
    notes = tmp_path / "notes.docx"
    notes.write_bytes(b"not really a word file")
    with pytest.raises(ValueError, match="pdfium reads PDF files; notes.docx is a Word file"):
        pandion.parse(notes, use="pdfium")


# -- reading each format with docling ------------------------------------------


def test_a_word_file_keeps_its_heading_levels_and_has_no_pages(tmp_path):
    path = tmp_path / "ferns.docx"
    path.write_bytes(docx_bytes())
    doc = parse(path)

    assert_pageless(doc)
    (ferns, top), (light, below) = headings(doc)
    assert (ferns, light) == ("Ferns", "Light")
    assert below > top
    assert "Ferns need water weekly." in [e.text for e in doc.elements]


def test_a_web_page_keeps_its_heading_levels_and_its_title(tmp_path):
    path = tmp_path / "ferns.html"
    path.write_text(HTML, encoding="utf-8")
    doc = parse(path)

    assert_pageless(doc)
    # The <title> sits in Docling's furniture layer; a page without pages has
    # no headers or footers there, so the title is read as the first heading.
    assert headings(doc) == [("Care guide", 1), ("Ferns", 1), ("Light", 2), ("Winter", 3)]
    assert doc.elements[0].text == "Care guide"
    assert [e.order for e in doc.elements] == list(range(len(doc.elements)))


def test_a_title_that_repeats_the_first_heading_is_read_once(tmp_path):
    path = tmp_path / "ferns.html"
    path.write_text(HTML.replace("Care guide", "Ferns"), encoding="utf-8")
    doc = parse(path)

    assert [text for text, _ in headings(doc)] == ["Ferns", "Light", "Winter"]


def test_a_web_page_title_is_not_counted_as_set_aside(tmp_path):
    path = tmp_path / "ferns.html"
    path.write_text(HTML, encoding="utf-8")
    assert pandion.parse(path, use="docling").note is None


def test_a_web_page_title_is_counted_when_furniture_is_read(tmp_path):
    path = tmp_path / "ferns.html"
    path.write_text(HTML, encoding="utf-8")
    result = pandion.parse(path, use="docling", content_layers=["body", "furniture"])

    assert result.note == "Docling read 1 block from its furniture layer into the text."
    assert headings(result.output)[0] == ("Care guide", 1)


def test_a_markdown_file_keeps_its_heading_levels(tmp_path):
    path = tmp_path / "ferns.md"
    path.write_text(MARKDOWN, encoding="utf-8")
    doc = parse(path)

    assert_pageless(doc)
    assert headings(doc) == [("Ferns", 1), ("Light", 2), ("Winter", 3)]


def test_a_text_file_is_read_as_paragraphs(tmp_path):
    path = tmp_path / "ferns.txt"
    path.write_text("Ferns need water weekly.\n\nThey like deep shade.\n", encoding="utf-8")
    doc = parse(path)

    assert_pageless(doc)
    assert [(e.type, e.text) for e in doc.elements] == [
        ("paragraph", "Ferns need water weekly."),
        ("paragraph", "They like deep shade."),
    ]


def test_a_powerpoint_file_has_one_page_per_slide(tmp_path):
    path = tmp_path / "ferns.pptx"
    path.write_bytes(pptx_bytes())
    doc = parse(path)

    assert doc.page_count == 2
    by_text = {e.text: e for e in doc.elements}
    assert by_text["Ferns"].type == "heading" and by_text["Ferns"].page == 1
    assert by_text["Light"].page == 2
    assert by_text["Ferns like deep shade."].page == 2


@pytest.mark.models
def test_an_image_is_one_page_read_with_ocr(tmp_path):
    path = tmp_path / "ferns.png"
    path.write_bytes(png_bytes())
    doc = parse(path)

    assert doc.page_count == 1
    text = " ".join(e.text for e in doc.elements).lower()
    assert "water weekly" in text
    assert all(e.page == 1 for e in doc.elements)


# -- downstream of a document without pages ------------------------------------


CHUNKERS = [
    {"use": "recursive_character", "chunk_size": 200, "chunk_overlap": 0, "heading_context": True},
    {"use": "layout_blocks", "heading_context": True},
    {"use": "markdown_header"},
    {"use": "token_based"},
    {"use": "sentence_window"},
]


@pytest.mark.parametrize("chunk", CHUNKERS, ids=[c["use"] for c in CHUNKERS])
def test_a_word_file_indexes_and_retrieves_end_to_end(tmp_path, chunk):
    pytest.importorskip("docling")
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "ferns.docx").write_bytes(docx_bytes())
    p = _pipeline(tmp_path, parse="docling", chunk=chunk)

    report = p.index.run(docs)
    assert report.ok, report

    result = p.retrieve("How often do ferns need water?")
    assert result.ok
    assert result.hits
    assert all(hit.chunk.page_span is None for hit in result.hits)
    assert any("water weekly" in hit.chunk.text for hit in result.hits)


def test_evaluation_and_the_miss_trace_work_without_pages(tmp_path):
    pytest.importorskip("docling")
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "ferns.docx").write_bytes(docx_bytes())
    p = _pipeline(tmp_path, parse="docling")

    report = pandion.evaluate(
        p,
        [
            {"id": "water", "question": "How often do ferns need water?",
             "gold_answer": "Ferns need water weekly."},
            {"id": "soil", "question": "What soil do ferns like?",
             "gold_answer": "Ferns grow best in peat."},
        ],
        documents=docs,
    )

    found = {q.id: q for q in report.questions}
    assert found["water"].found
    assert not found["soil"].found
    assert found["soil"].trace is not None
    assert str(report)


def test_an_answer_cites_a_piece_without_pages(tmp_path, monkeypatch):
    pytest.importorskip("docling")
    from pandion import llm
    from pandion.llm import Completion

    def complete(model, **kwargs):
        # Cites the first sentence of the first piece.
        return Completion(text="Ferns need water weekly [1.1].", usage={}, stop_reason="end_turn")

    monkeypatch.setattr(llm, "complete", complete)
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "ferns.docx").write_bytes(docx_bytes())
    p = Pipeline(
        path=tmp_path / "index",
        parse="docling",
        chunk={"use": "recursive_character", "chunk_size": 200, "chunk_overlap": 0},
        embed="fake-deterministic",
        store="lancedb",
        search={"use": "hybrid_rrf", "top_k": 3},
        answer={"use": "chat", "model": "gpt-6-astra"},
    )
    assert p.index.run(docs).ok

    answer = p.ask("How often do ferns need water?", credentials={"openai_api_key": "sk-test"})
    assert answer.ok, answer.stages["answer"].error

    citations = answer.output.payload["citations"]
    assert citations
    pieces = {hit.chunk.id: hit.chunk for hit in answer.hits}
    for citation in citations:
        assert citation["cited_text"]
        piece = pieces[citation["chunk_id"]]
        assert piece.page_span is None
        assert citation["cited_text"] in piece.text
        assert citation["page"] is None and citation["bbox"] is None
