"""The committed sample PDF: generated deterministically by `scripts/make_sample_pdf.py`."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "chunking-primer.pdf"


def _script():
    spec = importlib.util.spec_from_file_location(
        "make_sample_pdf", ROOT / "scripts" / "make_sample_pdf.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _page_texts(data: bytes) -> list[str]:
    pdf = pdfium.PdfDocument(data)
    try:
        return [" ".join(page.get_textpage().get_text_bounded().split()) for page in pdf]
    finally:
        pdf.close()


def test_build_is_deterministic():
    script = _script()
    assert script.build() == script.build()


def test_committed_sample_matches_the_generator():
    assert SAMPLE.read_bytes() == _script().build()


def test_sample_has_three_pages_each_with_a_footer():
    pages = _page_texts(_script().build())
    assert len(pages) == 3
    for n, text in enumerate(pages, start=1):
        assert "RAG Playground sample" in text
        assert f"Page {n}" in text


def test_sample_repeats_one_paragraph_on_two_pages():
    script = _script()
    key = " ".join(script.REPEATED.split())[:60]
    pages = _page_texts(script.build())
    assert sum(key in text for text in pages) == 2


def test_sample_covers_the_three_topics():
    text = " ".join(_page_texts(_script().build()))
    for heading in (
        "Why chunk boundaries matter",
        "Chunk size and overlap",
        "Structure-aware splitting",
    ):
        assert heading in text
