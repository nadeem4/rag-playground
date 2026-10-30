"""The cheap facts about a file, known before any parsing.

`document_info` reads what costs almost nothing: the name, size and format, the
page count and whether a PDF has a text layer, the first page's text, and the
properties stored inside the file (a PDF's Title and Author, a Word file's core
properties, an HTML page's title and meta tags, a photo's EXIF). A route looks
at these to choose a category. Reading the file's contents never fails: a fact
that cannot be read (a corrupt or encrypted file, a missing library) is left
empty. A file that does not exist is an error, from reading its size.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

from pandion.errors import require
from pandion.fetch import is_url
from pandion.formats import format_of

FIRST_PAGE_CHARS = 4000
HTML_BYTES = 64 * 1024
PDF_KEYS = ("Title", "Author", "Subject", "Keywords", "Creator", "Producer")
#: The core.xml element for each property key of a Word or PowerPoint file.
CORE_KEYS = {"title": "Title", "creator": "Author", "subject": "Subject",
             "keywords": "Keywords", "category": "Category"}


@dataclass(frozen=True)
class DocumentInfo:
    """What is cheap to know about a file. `path` is the folder path the file
    was added from, or its link; empty for a bare upload."""

    filename: str
    type: str | None
    size: int
    path: str
    metadata: dict[str, str]
    properties: dict[str, str]
    page_count: int | None
    text_layer: bool | None
    first_page_text: str


@dataclass
class _Facts:
    properties: dict[str, str] = field(default_factory=dict)
    page_count: int | None = None
    text_layer: bool | None = None
    first_page_text: str = ""


def document_info(
    file: Path, *, filename: str, doc_id: str, metadata: dict[str, str] | None = None
) -> DocumentInfo:
    """The cheap facts about `file`, which was added as `filename` with id `doc_id`."""
    kind = format_of(filename)
    reader = _READERS.get(kind or "")
    try:
        facts = reader(Path(file)) if reader else _Facts()
    except Exception:
        facts = _Facts()
    return DocumentInfo(
        filename=filename,
        type=kind,
        size=Path(file).stat().st_size,
        path=doc_id if "/" in doc_id or is_url(doc_id) else "",
        metadata=dict(metadata or {}),
        properties=facts.properties,
        page_count=facts.page_count,
        text_layer=facts.text_layer,
        first_page_text=facts.first_page_text[:FIRST_PAGE_CHARS],
    )


def _pdf(file: Path) -> _Facts:
    try:
        pdfium = require("pypdfium2", extra="pdfium", step="Reading a PDF's facts")
    except ImportError:
        return _Facts()
    doc = pdfium.PdfDocument(file)  # raises for a corrupt or encrypted file
    try:
        props = doc.get_metadata_dict()
        facts = _Facts(
            properties={k: props[k] for k in PDF_KEYS if props.get(k)},
            page_count=len(doc),
        )
        facts.text_layer = False
        for n in range(min(3, len(doc))):
            try:
                page = doc[n]
                try:
                    text = page.get_textpage().get_text_range()
                finally:
                    page.close()
            except Exception:
                continue  # one bad page keeps the other facts
            if n == 0:
                facts.first_page_text = text
            if text.strip():
                facts.text_layer = True
        return facts
    finally:
        doc.close()


def _office(file: Path) -> _Facts:
    with zipfile.ZipFile(file) as z:
        names = z.namelist()
        facts = _Facts()
        slides = [n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
        if slides:
            facts.page_count = len(slides)
        if "docProps/core.xml" in names:
            for el in ElementTree.fromstring(z.read("docProps/core.xml")):
                key = CORE_KEYS.get(el.tag.rsplit("}", 1)[-1])
                if key and (el.text or "").strip():
                    facts.properties[key] = el.text.strip()
        return facts


class _Head(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.props: dict[str, str] = {}
        self._title = False
        self._seen_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title" and not self._seen_title:
            self._title = self._seen_title = True
        elif tag == "meta":
            name, content = a.get("name") or a.get("property"), a.get("content")
            if name and content and name.lower() not in {k.lower() for k in self.props}:
                self.props[name] = content

    def handle_endtag(self, tag):
        if tag == "title":
            self._title = False

    def handle_data(self, data):
        if self._title and data.strip():
            for k in [k for k in self.props if k.lower() == "title" and k != "Title"]:
                del self.props[k]  # <title> wins over <meta name="title">
            self.props["Title"] = (self.props.get("Title", "") + data).strip()


def _text(file: Path) -> _Facts:
    with file.open("rb") as f:
        head = f.read(FIRST_PAGE_CHARS * 4)
    return _Facts(first_page_text=head.decode("utf-8", errors="ignore")[:FIRST_PAGE_CHARS])


def _html(file: Path) -> _Facts:
    with file.open("rb") as f:
        head = f.read(HTML_BYTES).decode("utf-8", errors="replace")
    parser = _Head()
    parser.feed(head)
    return _Facts(properties=parser.props)


def _image(file: Path) -> _Facts:
    try:
        from PIL import ExifTags, Image
    except ImportError:
        return _Facts()
    with Image.open(file) as img:
        exif = img.getexif()
        props = {ExifTags.TAGS.get(tag, str(tag)): str(value).strip("\x00 ") for tag, value in exif.items()
                 if not isinstance(value, bytes)}
    return _Facts(properties={k: v for k, v in props.items() if v})


_READERS = {"pdf": _pdf, "docx": _office, "pptx": _office, "html": _html, "md": _text, "txt": _text, "jpg": _image, "png": _image}
