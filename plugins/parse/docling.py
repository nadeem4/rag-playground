"""Layout-aware parsing with Docling, the recommended parser.

**One difference from the baseline.** Docling reads PDFs through pypdfium2 as
well, so it sees the same characters `pdfium` does. What it adds is a vision
layout model: every page is rendered and segmented into labelled regions
(title, section header, list item, table, page footer...) and a reading-order
model sequences them. Comparing the two parsers therefore isolates exactly one
thing: what layout understanding buys downstream retrieval.

**Lazy, because torch is heavy.** Nothing from docling (and so nothing from
torch) is imported at module level. Registering this plugin, `discover()`,
starting the API and the fast test suite must stay light; the import happens on
the first `apply()`. The constructed `DocumentConverter` is cached per option
set, because building one loads the models.

**Mapping.** Docling's labels map onto our `ElementType` in `map_label`, a pure
function. `page_footer` becomes `footer`, which `ParsedDoc.render_markdown()`
already keeps out of the projection. Docling sorts items into content layers
(body, furniture, background, invisible, notes) and `iterate_items()` reads
only body by default. `content_layers` is Docling's own
`included_content_layers`, so only the layers selected are read, as Docling
does. Page headers and footers from the furniture layer become paragraphs when
furniture is selected, because they are being read into the text on purpose.
The run note counts the furniture layer either way, since the layout model
sometimes takes real content near a page edge for a footer. Items with no text
(a picture without text) are skipped, as pdfium skips empty blocks, so `order`
stays contiguous.

**Boxes** use pdfium's convention: (left, bottom, right, top) in PDF points,
y growing upwards.

The first run downloads the layout and table models from Hugging Face.
"""

from __future__ import annotations

import io
import time
from importlib import metadata
from pathlib import Path
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field, field_validator

from core.artifacts import ArtifactType
from core.payloads import Element, ElementType, ParsedDoc
from core.ports import PortSpec, RunContext, Stage, set_note
from core.registry import register
from core.transform import Explanation, Transform

#: Markdown has six heading levels.
MAX_HEADING_LEVEL = 6

_DIRECT: dict[str, ElementType] = {
    "text": "paragraph",
    "paragraph": "paragraph",
    "list_item": "list_item",
    "table": "table",
    "picture": "figure",
    "caption": "caption",
    "page_header": "header",
    "page_footer": "footer",
    "footnote": "footnote",
    "formula": "formula",
    "code": "code",
}

#: Docling's labels for page furniture.
_FURNITURE = {"page_header", "page_footer"}

ContentLayerName = Literal["body", "furniture", "background", "invisible", "notes"]

#: Docling's content layers in its own order, with what each holds.
LAYERS: dict[str, str] = {
    "body": "the main content",
    "furniture": "page headers and footers",
    "background": "watermarks",
    "invisible": "hidden text",
    "notes": "author or speaker notes",
}


class DoclingConfig(BaseModel):
    do_ocr: bool = Field(
        default=False,
        description=(
            "Docling's PdfPipelineOptions.do_ocr. "
            "Read text from page images with OCR. Only needed for scanned PDFs "
            "with no text layer; it is much slower."
        ),
    )
    do_table_structure: bool = Field(
        default=True,
        description=(
            "Docling's PdfPipelineOptions.do_table_structure. "
            "Recover rows and columns of detected tables, so a table reaches "
            "the chunks as a markdown table instead of loose text."
        ),
    )
    table_mode: Literal["fast", "accurate"] = Field(
        default="fast",
        description=(
            "Docling's TableStructureOptions.mode, fast or accurate. "
            "Which table model to use. Fast is fine for simple grids; accurate "
            "handles merged cells better and takes longer."
        ),
    )
    content_layers: list[ContentLayerName] = Field(
        default_factory=lambda: ["body"],
        title="Content layers",
        description=(
            "Docling's included_content_layers: which layers of the page are "
            "read into the text. body is the main content and is always read. "
            "furniture is page headers and footers. background is watermarks. "
            "invisible is hidden text. notes are author or speaker notes."
        ),
    )

    @field_validator("content_layers")
    @classmethod
    def _body_first_in_doclings_order(cls, value: list[str]) -> list[str]:
        chosen = set(value) | {"body"}
        return [name for name in LAYERS if name in chosen]


def map_label(label: Any, level: int | None) -> tuple[ElementType, int | None]:
    """Docling label (string or enum) and header level -> (type, level).

    A title is level 1; section headers sit one level below their Docling
    level, so the title stays above every section. Unknown labels become
    paragraphs: `Element` has no metadata field to carry the original label.
    """
    name = str(getattr(label, "value", label))
    if name == "title":
        return "heading", 1
    if name == "section_header":
        return "heading", min((level or 1) + 1, MAX_HEADING_LEVEL)
    return _DIRECT.get(name, "paragraph"), None


def pdf_bbox(
    l: float, t: float, r: float, b: float, *, top_left: bool, page_height: float
) -> tuple[float, float, float, float]:
    """Docling's l/t/r/b to (left, bottom, right, top), PDF points, y up."""
    if top_left:
        t, b = page_height - t, page_height - b
    return (l, b, r, t)


def elements_from_document(
    doc: Any, *, content_layers: list[str] | tuple[str, ...] = ("body",)
) -> list[Element]:
    """Walk the selected content layers of a DoclingDocument in reading order.

    Only those layers are read, as `iterate_items(included_content_layers=...)`
    does in Docling. Page headers and footers from the furniture layer become
    paragraphs, since selecting furniture means reading them into the text.
    """
    from docling_core.types.doc import ContentLayer

    furniture_read = "furniture" in content_layers
    layers = {ContentLayer(name) for name in content_layers}
    elements: list[Element] = []
    for item, _depth in doc.iterate_items(included_content_layers=layers):
        label = str(getattr(item.label, "value", item.label))
        in_furniture = getattr(item, "content_layer", None) == ContentLayer.FURNITURE
        if furniture_read and in_furniture and label in _FURNITURE:
            type_, level = "paragraph", None
        else:
            type_, level = map_label(item.label, getattr(item, "level", None))
        if type_ == "table" and hasattr(item, "export_to_markdown"):
            text = item.export_to_markdown(doc=doc)
        else:
            text = getattr(item, "text", "") or ""
        text = text.strip()
        if not text:
            continue

        page = bbox = None
        prov = getattr(item, "prov", None) or []
        if prov:
            page = prov[0].page_no
            box = prov[0].bbox
            origin = str(getattr(box.coord_origin, "value", box.coord_origin))
            page_item = doc.pages.get(page)
            height = page_item.size.height if page_item is not None else 0.0
            bbox = pdf_bbox(box.l, box.t, box.r, box.b,
                            top_left=origin.upper() == "TOPLEFT", page_height=height)

        order = len(elements)
        elements.append(
            Element(id=f"e{order:05d}", type=type_, text=text, order=order,
                    page=page, bbox=bbox, level=level)
        )
    return elements


def furniture_count(doc: Any) -> int:
    """How many items with text Docling filed in its furniture layer."""
    from docling_core.types.doc import ContentLayer

    return sum(
        1
        for item, _depth in doc.iterate_items(
            included_content_layers={ContentLayer.FURNITURE}
        )
        if (getattr(item, "text", "") or "").strip()
    )


def furniture_note(count: int, *, read: bool) -> str | None:
    """The run note about the furniture layer, or None if it was empty."""
    if not count:
        return None
    blocks = "block" if count == 1 else "blocks"
    if read:
        return f"Docling read {count} {blocks} from its furniture layer into the text."
    it_is = "it is" if count == 1 else "they are"
    return (
        f"Docling set aside {count} {blocks} in its furniture layer, which holds "
        f"page headers and footers, so {it_is} not in the text. Add furniture "
        "under Content layers if something near a page edge is missing."
    )


def _version(package: str) -> str:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError:
        return "missing"


#: Constructed converters, keyed by the options that change them.
_CONVERTERS: dict[tuple, Any] = {}


def _converter(config: DoclingConfig) -> Any:
    key = (config.do_ocr, config.do_table_structure, config.table_mode)
    if key not in _CONVERTERS:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import (
            PdfPipelineOptions,
            TableFormerMode,
            TableStructureOptions,
        )
        from docling.document_converter import DocumentConverter, PdfFormatOption

        options = PdfPipelineOptions(
            do_ocr=config.do_ocr,
            do_table_structure=config.do_table_structure,
            table_structure_options=TableStructureOptions(
                mode=TableFormerMode(config.table_mode)
            ),
        )
        _CONVERTERS[key] = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
        )
    return _CONVERTERS[key]


@register
class DoclingParse(Transform[DoclingConfig]):
    """`raw_file -> parsed_doc`, with a vision layout model."""

    name = "docling"
    #: Headings come out as heading elements, which `markdown_header` prefers.
    provides = {"structure": ["headings"]}
    version = "3"
    stage = Stage.PARSE
    inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
    output = ArtifactType.PARSED_DOC
    config_model = DoclingConfig
    deterministic = True
    summary = (
        "Renders each page as an image and runs a layout model that labels every "
        "region: title, section heading, list item, table, page header and "
        "footer. A reading-order model then puts the regions in sequence. Much "
        "slower than pdfium, with far more structure."
    )

    def explain(self, config: DoclingConfig) -> Explanation:
        if config.do_ocr:
            ocr = (
                "OCR is on: text is also read from the page images, which "
                "recovers scanned pages but is much slower."
            )
        else:
            ocr = (
                "OCR is off, so only the text stored in the PDF is read; a "
                "scanned page would come out empty."
            )
        if config.do_table_structure:
            model = (
                "the fast table model, fine for simple grids"
                if config.table_mode == "fast"
                else "the accurate table model, better with merged cells but slower"
            )
            tables = (
                f"Tables are rebuilt as rows and columns with {model}, so a table "
                "reaches the pieces as a markdown table."
            )
        else:
            tables = (
                "Table structure is off, so a table comes through as loose text, "
                f"and the table model setting ({config.table_mode}) is not used."
            )
        if config.content_layers == ["body"]:
            layers = "Only the body layer, the main content, is read into the text."
        else:
            named = "; ".join(f"{name}, {LAYERS[name]}" for name in config.content_layers)
            layers = f"These layers are read into the text: {named}."
        return Explanation(
            settings=f"{ocr} {tables} {layers}",
            tradeoff=(
                "The first run downloads the layout models, and each page takes "
                "seconds rather than milliseconds, but you get headings, which "
                "markdown_header needs to split by section."
            ),
        )

    def fingerprint(self, config: DoclingConfig | None = None) -> str:
        # The models ship inside these packages' releases, so their versions
        # are the model identity.
        return (
            f"docling={_version('docling')};"
            f"docling-ibm-models={_version('docling-ibm-models')}"
        )

    def apply(
        self, inputs: Mapping[str, Any], config: DoclingConfig, ctx: RunContext
    ) -> dict[str, Any]:
        from docling.datamodel.base_models import DocumentStream

        raw = inputs["file"]
        path = Path(raw["path"])
        converter = _converter(config)

        # Bytes, not the path, for the same reason as pdfium: an open handle
        # would stop the store's commit moving the directory on Windows.
        stream = DocumentStream(name=path.name, stream=io.BytesIO(path.read_bytes()))
        started = time.perf_counter()
        result = converter.convert(stream)
        seconds = time.perf_counter() - started

        doc = result.document
        page_count = len(doc.pages)
        elements = elements_from_document(doc, content_layers=config.content_layers)
        note = furniture_note(
            furniture_count(doc), read="furniture" in config.content_layers
        )
        if note:
            set_note(ctx, note)
        return ParsedDoc(
            elements=elements,
            page_count=page_count,
            source_id=raw.get("sha", ""),
            filename=raw.get("filename", ""),
            parser_meta={
                "parser": self.name,
                "docling_version": _version("docling"),
                "seconds_total": round(seconds, 3),
                "seconds_per_page": round(seconds / page_count, 3) if page_count else 0.0,
            },
        ).model_dump(mode="json")
