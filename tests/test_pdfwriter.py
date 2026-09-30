"""The hand-written PDF writer produces what pdfium reads back."""

from __future__ import annotations

import sys
import zlib
from pathlib import Path

import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.samplegen.pdfwriter import Document, Page  # noqa: E402

BODY = ("F1", 11, 15, 40)
BOLD = ("F2", 11, 15, 40)


def page_texts(data: bytes) -> list[str]:
    doc = pdfium.PdfDocument(data)
    try:
        return [doc[i].get_textpage().get_text_range() for i in range(len(doc))]
    finally:
        doc.close()


def test_two_columns_read_back_in_drawing_order():
    page = Page()
    page.wrap(BODY, "left one left two", 72, 700)
    page.wrap(BODY, "right one right two", 320, 700)
    (text,) = page_texts(Document([page]).build())
    assert "left one left two" in text
    assert "right one right two" in text


def test_cell_grid_draws_every_cell_and_rules():
    page = Page()
    bottom = page.cell_grid(72, 700, [120, 60, 60], 18, [["Item", "Before", "After"], ["Reading time", "14", "9"]], BODY, BOLD)
    data = Document([page]).build()
    (text,) = page_texts(data)
    for cell in ["Item", "Before", "After", "Reading time", "14", "9"]:
        assert cell in text
    assert bottom == 700 - 2 * 18
    assert data.count(b" l S") >= 7  # 3 horizontal + 4 vertical rules


def test_image_page_has_no_text_and_a_flate_xobject():
    pixels = bytes([255] * (20 * 10))
    page = Page()
    page.image("Im1", 72, 600, 200, 100, pixels, 20, 10)
    data = Document([page]).build()
    (text,) = page_texts(data)
    assert text.strip() == ""
    assert b"/Subtype /Image /Width 20 /Height 10 /ColorSpace /DeviceGray" in data
    assert zlib.compress(pixels, 9) in data
    assert b"/Im1 Do" in data


def test_pages_without_images_keep_the_plain_resources_dictionary():
    page = Page()
    page.text("F1", 11, 72, 700, "hello")
    data = Document([page]).build()
    assert b"/XObject" not in data
