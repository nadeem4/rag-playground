"""DocumentInfo: the cheap facts about a file, read before any parsing."""

import io
import zipfile

import pytest
from pdfs import build_pdf

import pandion.docinfo as docinfo
from pandion.docinfo import DocumentInfo, document_info
from pandion.extend import DocumentInfo as Exported

CORE = (
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">'
    "<dc:title>Quarterly plan</dc:title><dc:creator>Ada</dc:creator><dc:subject>Money</dc:subject>"
    "<cp:keywords>budget, plan</cp:keywords><cp:category>Finance</cp:category></cp:coreProperties>"
)


def write_zip(path, members):
    with zipfile.ZipFile(path, "w") as z:
        for name, text in members.items():
            z.writestr(name, text)
    return path


def info_of(path, name=None, doc_id=None, **kw):
    name = name or path.name
    return document_info(path, filename=name, doc_id=doc_id or name, **kw)


@pytest.fixture
def pdf(tmp_path):
    p = tmp_path / "a.pdf"
    p.write_bytes(build_pdf([["Hello there."], ["Second page."]]))
    return p


def test_basic_facts(pdf):
    info = document_info(pdf, filename="a.pdf", doc_id="a.pdf")
    assert info.type == "pdf" and info.filename == "a.pdf"
    assert info.size == pdf.stat().st_size
    assert Exported is DocumentInfo


@pytest.mark.parametrize(
    ("doc_id", "path"),
    [("legal/a.pdf", "legal/a.pdf"), ("https://x.org/p", "https://x.org/p"), ("a.pdf", "")],
)
def test_path_is_the_folder_path_or_link_or_empty(pdf, doc_id, path):
    assert document_info(pdf, filename="a.pdf", doc_id=doc_id).path == path


def test_metadata_is_copied(pdf):
    given = {"team": "legal"}
    info = document_info(pdf, filename="a.pdf", doc_id="a.pdf", metadata=given)
    given["team"] = "x"
    assert info.metadata == {"team": "legal"}


def test_pdf_with_text_has_a_text_layer_and_first_page_text(pdf):
    info = info_of(pdf)
    assert info.text_layer is True
    assert "Hello there." in info.first_page_text


def test_pdf_without_text_has_no_text_layer(tmp_path):
    p = tmp_path / "blank.pdf"
    p.write_bytes(build_pdf([[]]))
    info = info_of(p)
    assert info.text_layer is False and info.first_page_text == ""


def test_page_count_of_pdf_and_pptx(pdf, tmp_path):
    assert info_of(pdf).page_count == 2
    p = write_zip(tmp_path / "s.pptx", {"ppt/slides/slide1.xml": "", "ppt/slides/slide2.xml": "",
                                         "ppt/slides/slide3.xml": "", "ppt/slides/_rels/slide1.xml.rels": ""})
    assert info_of(p).page_count == 3


def test_pdf_properties_title_and_author(tmp_path):
    p = tmp_path / "t.pdf"
    p.write_bytes(build_pdf([["x"]], info={"Title": "Annual report", "Author": "Ada"}))
    props = info_of(p).properties
    assert props["Title"] == "Annual report" and props["Author"] == "Ada"
    assert "Subject" not in props


def test_docx_core_properties(tmp_path):
    p = write_zip(tmp_path / "a.docx", {"docProps/core.xml": CORE})
    assert info_of(p).properties == {
        "Title": "Quarterly plan", "Author": "Ada", "Subject": "Money",
        "Keywords": "budget, plan", "Category": "Finance",
    }


def test_docx_without_core_properties(tmp_path):
    p = write_zip(tmp_path / "a.docx", {"word/document.xml": "<x/>"})
    assert info_of(p).properties == {}


def test_pptx_core_properties(tmp_path):
    p = write_zip(tmp_path / "a.pptx", {"docProps/core.xml": CORE})
    assert info_of(p).properties["Title"] == "Quarterly plan"


def test_html_title_and_meta(tmp_path):
    p = tmp_path / "a.html"
    p.write_text(
        '<html><head><title>My page</title><meta name="description" content="About it">'
        '<meta property="og:title" content="Shared title"></head><body>hi</body></html>',
        encoding="utf-8",
    )
    props = info_of(p).properties
    assert props == {"Title": "My page", "description": "About it", "og:title": "Shared title"}


def test_jpg_exif_when_pillow_is_there(tmp_path):
    Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "a.jpg"
    img = Image.new("RGB", (4, 4))
    exif = Image.Exif()
    exif[0x010F] = "Acme"  # Make
    img.save(p, exif=exif)
    assert info_of(p).properties["Make"] == "Acme"


def test_md_and_txt_have_no_properties(tmp_path):
    p = tmp_path / "a.md"
    p.write_text("# Hi\n", encoding="utf-8")
    info = info_of(p)
    assert info.properties == {} and info.page_count is None and info.text_layer is None


def test_corrupt_files_give_no_facts_and_no_error(pdf, tmp_path):
    cut = tmp_path / "cut.pdf"
    cut.write_bytes(pdf.read_bytes()[:60])
    notdocx = tmp_path / "x.docx"
    notdocx.write_bytes(b"not a zip at all")
    notzip = write_zip(tmp_path / "y.docx", {"other.txt": "hi"})
    png = tmp_path / "x.png"
    png.write_bytes(b"\x00\x01 junk")
    for f in (cut, notdocx, notzip, png):
        info = info_of(f)
        assert info.properties == {} and info.page_count is None and info.text_layer in (None, False)
        assert info.first_page_text == ""


def test_encrypted_pdf_gives_empty_properties(tmp_path):
    data = build_pdf([["secret"]])
    trailer = data.rindex(b"trailer")
    fake = b"/Encrypt << /Filter /Standard /V 1 /R 2 /O (" + b"a" * 32 + b") /U (" + b"b" * 32 + b") /P -4 >> "
    data = data[:trailer] + data[trailer:].replace(b"/Root", fake + b"/Root", 1)
    p = tmp_path / "enc.pdf"
    p.write_bytes(data)
    info = info_of(p)
    assert info.properties == {} and info.first_page_text == ""


def test_without_pdfium_text_layer_is_none(pdf, monkeypatch):
    def missing(*a, **k):
        raise ImportError("no pdfium")

    monkeypatch.setattr(docinfo, "require", missing)
    info = info_of(pdf)
    assert info.text_layer is None and info.page_count is None and info.properties == {}
    assert info.type == "pdf"


def test_first_page_text_is_capped_at_4000_characters(tmp_path):
    p = tmp_path / "long.pdf"
    p.write_bytes(build_pdf([["word " * 100] * 60]))
    assert len(info_of(p).first_page_text) == 4000


def test_unknown_extension_has_no_type(tmp_path):
    p = tmp_path / "a.xyz"
    p.write_bytes(b"data")
    info = info_of(p)
    assert info.type is None and info.size == 4
