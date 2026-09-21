"""`docling` is the layout-aware parser beside the `pdfium` baseline.

Both read the PDF through pdfium; Docling adds a vision layout model that labels
regions (heading, list item, table, page footer...) and repairs reading order.

The fast half runs with no models: the label mapping, bbox conversion and the
walk over a Docling document are pure functions tested on stand-in objects, and
importing the plugin must not import torch or docling at all. The slow half,
marked `models`, runs real conversions.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.artifacts import ArtifactType
from core.payloads import ParsedDoc
from core.ports import Stage
from core.registry import registry

import plugins.parse.docling as docling_plugin
from plugins.parse.docling import elements_from_document, map_label, pdf_bbox

from tests.plugins.conftest import build_paragraph_pdf

ROOT = Path(__file__).resolve().parents[2]


# -- registration and config --------------------------------------------------


def test_registered_under_the_parse_stage():
    cls = registry.get(Stage.PARSE, "docling")
    assert cls.output is ArtifactType.PARSED_DOC
    assert set(cls.inputs) == {"file"}
    assert cls.inputs["file"].type is ArtifactType.RAW_FILE
    assert cls.version == "1"
    assert cls.deterministic is True


def test_config_defaults():
    cfg = registry.get(Stage.PARSE, "docling").config_model()
    assert cfg.do_ocr is False
    assert cfg.do_table_structure is True
    assert cfg.table_mode == "fast"


def test_every_config_field_has_plain_help_text():
    model = registry.get(Stage.PARSE, "docling").config_model
    for name, field in model.model_fields.items():
        assert field.description, f"{name} has no description"
        assert chr(0x2014) not in field.description, f"{name} uses an em-dash"


def test_table_mode_rejects_unknown_values():
    model = registry.get(Stage.PARSE, "docling").config_model
    with pytest.raises(Exception):
        model(table_mode="slow")


def test_fingerprint_names_the_installed_model_packages():
    inst = registry.get(Stage.PARSE, "docling")()
    fp = inst.fingerprint()
    assert "docling=" in fp and "docling-ibm-models=" in fp
    assert fp == inst.fingerprint(inst.config_model())


def test_importing_the_plugin_does_not_import_torch_or_docling():
    """Registering, discover(), the API and the fast suite must stay light.

    A subprocess, so nothing an earlier test imported can mask the leak.
    """
    code = (
        "import sys\n"
        "import plugins\n"
        "plugins.discover()\n"
        "import plugins.parse.docling\n"
        "leaked = sorted(m for m in sys.modules "
        "if m.split('.')[0] in {'torch', 'docling', 'docling_core', "
        "'docling_ibm_models', 'transformers'})\n"
        "print(leaked)\n"
        "sys.exit(1 if leaked else 0)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr


# -- label mapping ------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("text", "paragraph"),
        ("paragraph", "paragraph"),
        ("list_item", "list_item"),
        ("table", "table"),
        ("picture", "figure"),
        ("caption", "caption"),
        ("page_header", "header"),
        ("page_footer", "footer"),
        ("footnote", "footnote"),
        ("formula", "formula"),
        ("code", "code"),
    ],
)
def test_label_maps_to_element_type(label, expected):
    assert map_label(label, None) == (expected, None)


def test_title_is_a_level_one_heading():
    assert map_label("title", None) == ("heading", 1)


def test_section_headers_sit_below_the_title():
    assert map_label("section_header", 1) == ("heading", 2)
    assert map_label("section_header", 2) == ("heading", 3)
    assert map_label("section_header", None) == ("heading", 2)


def test_heading_levels_are_capped_at_markdown_depth():
    assert map_label("section_header", 9) == ("heading", 6)


def test_unknown_labels_fall_back_to_paragraph():
    assert map_label("key_value_region", None) == ("paragraph", None)
    assert map_label("checkbox_selected", 3) == ("paragraph", None)


def test_enum_labels_are_accepted():
    label = SimpleNamespace(value="section_header")
    assert map_label(label, 1) == ("heading", 2)


# -- bbox conversion ----------------------------------------------------------


def test_bottom_left_bbox_is_reordered_to_left_bottom_right_top():
    # Docling's l, t, r, b with y growing upwards: top is the larger y.
    assert pdf_bbox(44.4, 104.3, 569.9, 26.2, top_left=False, page_height=792) == (
        44.4, 26.2, 569.9, 104.3
    )


def test_top_left_bbox_is_flipped_into_pdf_points():
    # 10pt from the top of a 792pt page is y=782 in PDF space.
    assert pdf_bbox(72, 10, 300, 40, top_left=True, page_height=792) == (
        72, 752, 300, 782
    )


# -- walking a Docling document -----------------------------------------------


def _prov(page, l, t, r, b):
    return SimpleNamespace(
        page_no=page,
        bbox=SimpleNamespace(l=l, t=t, r=r, b=b,
                             coord_origin=SimpleNamespace(value="BOTTOMLEFT")),
    )


def _item(label, text="", page=1, level=None, box=(10, 700, 200, 680), md=None):
    item = SimpleNamespace(label=SimpleNamespace(value=label), text=text,
                           prov=[_prov(page, *box)] if page else [])
    if level is not None:
        item.level = level
    if md is not None:
        item.export_to_markdown = lambda doc=None: md
    return item


class _FakeDoc:
    def __init__(self, items, pages=2, height=792):
        self._items = items
        self.pages = {n: SimpleNamespace(size=SimpleNamespace(height=height))
                      for n in range(1, pages + 1)}

    def iterate_items(self):
        for item in self._items:
            yield item, 0


def test_document_walk_maps_types_order_pages_and_bboxes():
    doc = _FakeDoc([
        _item("title", "Chunking notes"),
        _item("section_header", "Boundaries", level=1),
        _item("text", "A retriever sees chunks."),
        _item("list_item", "Overlap costs storage.", page=2),
        _item("table", "", page=2, md="| a | b |\n|---|---|\n| 1 | 2 |"),
        _item("page_footer", "We are proud to be an equal opportunity workplace.", page=2),
    ])
    elements = elements_from_document(doc)
    assert [(e.type, e.level, e.page) for e in elements] == [
        ("heading", 1, 1),
        ("heading", 2, 1),
        ("paragraph", None, 1),
        ("list_item", None, 2),
        ("table", None, 2),
        ("footer", None, 2),
    ]
    assert [e.order for e in elements] == list(range(6))
    assert [e.id for e in elements] == [f"e{i:05d}" for i in range(6)]
    assert elements[0].bbox == (10, 680, 200, 700)
    assert elements[4].text == "| a | b |\n|---|---|\n| 1 | 2 |"


def test_items_with_no_text_are_skipped_and_order_stays_contiguous():
    doc = _FakeDoc([
        _item("picture", ""),
        _item("text", "Kept."),
        _item("text", "   "),
        _item("text", "Also kept.", page=None),
    ])
    elements = elements_from_document(doc)
    assert [e.text for e in elements] == ["Kept.", "Also kept."]
    assert [e.order for e in elements] == [0, 1]
    assert elements[1].page is None and elements[1].bbox is None


def test_footers_stay_in_elements_but_out_of_the_markdown():
    doc = _FakeDoc([
        _item("text", "Body text."),
        _item("page_footer", "Equal opportunity notice."),
    ])
    parsed = ParsedDoc(elements=elements_from_document(doc))
    markdown, _ = parsed.render_markdown()
    assert markdown == "Body text."
    assert parsed.elements[1].type == "footer"


# -- slow half: real conversions ----------------------------------------------


def parse(path: Path, **config) -> ParsedDoc:
    cls = registry.get(Stage.PARSE, "docling")
    payload = cls().apply(
        {"file": {"sha": "a" * 64, "filename": path.name, "path": str(path),
                  "mime": "application/pdf"}},
        cls.config_model(**config),
        None,
    )
    assert isinstance(payload, dict), "payload must be JSON-ready"
    return ParsedDoc(**payload)


PARAGRAPHS = [
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


@pytest.mark.models
def test_real_conversion_of_a_generated_paragraph_pdf(tmp_path: Path):
    path = tmp_path / "paragraphs.pdf"
    path.write_bytes(build_paragraph_pdf(PARAGRAPHS))
    doc = parse(path)

    assert doc.page_count == 2
    assert doc.source_id == "a" * 64
    assert doc.parser_meta["parser"] == "docling"
    assert doc.parser_meta["docling_version"]
    assert doc.parser_meta["seconds_per_page"] >= 0
    assert [e.order for e in doc.elements] == list(range(len(doc.elements)))

    texts = " ".join(e.text for e in doc.elements)
    assert "It sees chunks, and it can only return what a chunk contains." in texts
    assert "at the cost of storage." in texts
    assert {e.page for e in doc.elements} == {1, 2}
    for e in doc.elements:
        left, bottom, right, top = e.bbox
        assert 0 <= left < right <= 612 and 0 <= bottom < top <= 792
    # Reading order runs down the page, and PDF y grows upwards.
    first_page = [e for e in doc.elements if e.page == 1]
    assert first_page[0].bbox[3] > first_page[-1].bbox[3]


JOB_POSTING = ROOT / "sources" / (
    "b6e70d4d9a7b0c827c7ad66d16235cf0b6f69dc4b746628e990c3d7163ea58a3.pdf"
)


@pytest.mark.models
@pytest.mark.skipif(not JOB_POSTING.exists(), reason="the user's job posting is not present")
def test_job_posting_recovers_the_structure_pdfium_misses():
    doc = parse(JOB_POSTING)
    by_text = {e.text: e for e in doc.elements}

    # (b) the three section headings come out as three separate headings.
    for heading in ("Build & Test Acceleration", "CI/CD Pipeline Management",
                    "Environment Provisioning"):
        assert heading in by_text, heading
        assert by_text[heading].type == "heading"

    # (c) "Qualifications:" is a heading and the bullets are list items.
    assert by_text["Qualifications:"].type == "heading"
    assert sum(e.type == "list_item" for e in doc.elements) >= 20

    # (a) the equal-opportunity notice is never read first on a page.
    for page in range(1, doc.page_count + 1):
        on_page = [e for e in doc.elements if e.page == page]
        assert not on_page[0].text.startswith("We are proud"), page
